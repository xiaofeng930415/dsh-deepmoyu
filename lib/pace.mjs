/**
 * lib/pace.mjs —— 出手的节奏（2026-10-21 使用者 m18802 第 1 条）
 * ============================================================================
 * 使用者原话：
 *   「1 发表视频评论不要太频繁，如果短时间内连点，比如几分钟发十几条，系统就可能会判为机器
 *     2 所有操作要放慢节奏，不要一次性大量发，要适当间隔一点时间」
 *
 * 为什么要在**宿主**这一层做，而不是写在章程里让模型自己数着：
 *   章程只是"建议"，而模型一轮里会连着调好几次工具（回复 8 条评论、发 1 条动态、回 3 条私信），
 *   它自己数着数着就忘了 —— 这和"判重只写在章程里"是同一个教训：**能被机器保证的，就别交给记性**。
 *
 * 四道闸，从硬到软：
 *   ① 冷却（cooldown）—— 被风控打过一次，就整体停一段时间。这是**唯一**会因为远端反馈而改变的闸。
 *   ② 连发（burst）—— 10 分钟里发太多条，不管间隔多均匀，整体停下来喘一口。
 *   ③ 小时上限（hour）—— 每类动作每小时最多几条。防"一天额度 100 条，一小时全刷完"。
 *   ④ 最小间隔（gap）—— 同类动作两次之间至少隔多久，**带随机抖动**。
 *      ⚠️ 抖动不是装饰：固定 120 秒一次、分毫不差，本身就是机器特征。
 *
 * 设计上刻意做成**纯函数**（进出都是普通对象、时间与随机都从参数进）：
 *   · 要能在 devtools 里离线跑断言，不用起宿主；
 *   · 不许有隐藏状态 —— 账本一律存在 state.json 的 `pace` 键里（跨轮、跨进程都在）。
 * ============================================================================
 */

/** 一分钟多少毫秒（下面整张表都用它，省得数零数错） */
const MIN = 60_000

/**
 * 每类"会被人看见的动作"的节奏。
 *
 * gap     —— 同类两次之间的**基础**间隔
 * jitter  —— 在上面的基础上再随机多等 0..jitter 毫秒（每次成功发送时就把"下次最早什么时候"钉死）
 * hour    —— 滚动一小时内的上限
 * label   —— 给提示与界面看的人话
 *
 * ⚠️ 为什么评论的间隔最长（2 分钟）、回复短一点（1 分钟）：
 *   回复是**有人先跟它说话**，回得慢会显得断线；新评论是它自己主动开口，慢一点完全没损失。
 * ⚠️ 回动态评论（20 秒起）比回视频评论还快：动态评论区流量小得多，而且这正是「能回尽量回」
 *   的那一类 —— 使用者 2026-10-21 明确要求「别太长，能回尽量回」，所以只留够防连点的间隔。
 * ⚠️ 私信 30 秒起（原来是 90 秒）：私信在举报体系里权重仍然最高，但**回**私信跟主动**发**私信
 *   不是一回事 —— 对方先来找你，晾着更失礼。使用者要求「能回尽量回」，所以压到 30 秒；
 *   真被举报的判据是「对着同一个人刷屏」，那条靠判重账本挡，不靠把所有人都晾着。
 * ⚠️ 动态最慢（10 分钟起）：B站 动态一天本来就发不了几条，发快了最刺眼。
 */
export const PACE = {
  comment: { gap: 120 * MIN / 60, jitter: 60_000, hour: 8, label: '发新评论' },
  reply: { gap: 60_000, jitter: 30_000, hour: 15, label: '回评论' },
  opusReply: { gap: 20_000, jitter: 10_000, hour: 30, label: '回动态评论' },
  dm: { gap: 30_000, jitter: 15_000, hour: 20, label: '回私信' },
  moment: { gap: 600_000, jitter: 300_000, hour: 1, label: '发动态' },
}

/** 所有合法动作名（顺序就是界面/提示里的顺序） */
export const PACE_KINDS = ['comment', 'reply', 'opusReply', 'dm', 'moment']

/**
 * 用户主动选择的间隔预设；只描述系数，不改配置或账本。
 * responsive 适合想及时接话时选择，不代表 B站 认可的安全频率。
 * 小时上限、滚动连发、额度停牌与风控冷却始终不随系数缩短。
 */
export const PACE_PRESETS = Object.freeze({ normal: 1, responsive: 0.5, cautious: 1.5 })

/**
 * 连发闸：window 毫秒内只要发了 max 条（**不分类型，全算**），就整体多等 extra。
 * 为什么不分类型：风控看的是"这个号在动"，不是"这个号在发评论"。
 * 使用者举的例子是"几分钟发十几条" —— 这里定得比那个更早刹车（10 分钟 10 条）。
 * ⚠️ 原来 max 是 6（2026-10-21 之前），使用者当天要求"私信和动态评论能回尽量回"：
 *   6 条在 10 分钟里太紧，回三四条评论 + 两条私信就撞闸，剩下的人只能下一轮再说。
 *   放到 10 条——仍然是"十几条会被判机器"之前就刹车，但够回一批人了。
 */
export const BURST = { windowMs: 10 * MIN, max: 10, extraWaitMs: 180_000 }

/**
 * 远端明确说"你在被风控"时，停多久。
 * 键是 B站 的返回码（`code` 字段 / 异常里的 code，取字符串化后的原样）。
 *
 * ⚠️ 这些是**保守值**，宁可停久一点：-352 是 wbi/UA 校验没过（多半是机器特征被认出来了），
 *   -412 是 IP 级封禁（官方口径常见 15 分钟起跳，但重试会续封，所以给 1 小时），
 *   -509/-799 是显式的"请求过于频繁"。冷却期内**一条都不发**，比被续封划算得多。
 * ⚠️ 不在表里的码（比如 -101 没登录、-403 权限）不进冷却：那不是"太快"，是别的问题，
 *   停着也不会好，该把话说清楚让它去处理。
 */
export const RISK_COOLDOWN = {
  '-352': 20 * MIN,
  '-412': 60 * MIN,
  '-509': 30 * MIN,
  '-799': 30 * MIN,
  /* ⚠️ 12014（评论额度用完）**不在这里** —— 它不是"太快"，是"今天没额度了"；
   *   而且只能停评论那一类，不能连私信/动态一起停。见下面的 QUOTA_CODES。
   *   （2026-10-21 实测：10-20 一天发了 290 条，22:44 起 12014 就没停过，到第二天上午还在。） */
}

/**
 * 远端码 → 「哪个桶的额度用完了」。
 * 不是风控（不是"太快"），是**这个号今天不许再干这件事了**，试一次亏一次。
 *
 * ⭐ 2026-11-10 私信码（规格 #1751 E 段）：21020 / 21046 / 21015 / 25003 全在 dm 桶。
 *   其中 21046（"请在24小时后再发"）**必须**按桶停牌，绝不能升级成全局冷却 ——
 *   与 12014 同一条理由：连坐等于把一条通着的通道一起废掉。
 *   21047（关系门）**故意不在这两张表里**：它是"对方回复前只能发一条"的正常业务结果，
 *   不是风控也不是额度，宿主在 dm 发送链里单独判（重试只会更像骚扰）。
 */
export const QUOTA_CODES = { '12014': 'comment', '21020': 'dm', '21046': 'dm', '21015': 'dm', '25003': 'dm' }

/**
 * 桶 → 它管住哪几类动作。
 * ⚠️ 视频评论额度满了，**回私信、发动态都不受影响** —— 停牌绝不能连坐，
 *    不然就等于账号被封，而这只是"今天不能评论"。
 * ⚠️ 2026-10-21 真机实测：视频评论报 12014 的同一分钟里，`bili_reply_opus` 照样发成功
 *    （rpid 317701684385 真发出去了）—— 所以 **`opusReply` 不归这个桶**，它也归进来
 *    就等于白白把一条通的通道停到次日，纯亏。只停 comment（发新评论）+ reply（回视频评论）。
 * ⭐ 2026-11-10：dm 桶只停 dm。平台明说"24小时后再发"（21046）时停 24 小时是它的原话，
 *   但绝不能因此牵连评论/回复/动态 —— 那是另一条通道。
 */
export const QUOTA_SCOPES = {
  comment: ['comment', 'reply'],
  dm: ['dm'],
}

/** 这个 kind 被哪个额度桶管着（没被管就是空串） */
export const quotaBucketOf = (kind) => {
  for (const [bucket, kinds] of Object.entries(QUOTA_SCOPES)) {
    if (kinds.includes(kind)) return bucket
  }
  return ''
}

/**
 * 额度停牌停多久。
 *
 * ⚠️ 2026-10-21 使用者原话：「把停牌时长改短一点」。原来这里算的是**次日 00:05**
 *    （最长能停 24 小时）—— 太长了：真要是额度中途恢复，它得白等一整天；
 *    而实测 10-20 22:44 撞的 12014 到 10-21 上午还没放开，说明"一天"这个假设本身也不可靠。
 *
 * 现在改成**短停 + 递增**：
 *   第一次 45 分钟 → 再撞 90 分钟 → 再撞 180 分钟（封顶 3 小时）。
 *   每停一次就探一次：恢复了立刻接着回（这就是"能回尽量回"），没恢复也只是多等一会儿，
 *   不会像原来那样一口气把到午夜的时间全押进去。
 * ⚠️ 但绝不允许停过 00:05：B站 的日额度真要是在零点刷新，压在午夜之后就是白等 ——
 *    所以 `quotaParkUntil` 还要和 `nextQuotaReset` 取更早的那个。
 */
export const QUOTA_PARK_MS = 45 * MIN
export const QUOTA_PARK_MAX_MS = 3 * 60 * MIN
/**
 * ⭐ dm 桶的停牌上限：24 小时（规格 #1751 E 段，21046 的平台原话就是"请在24小时后再发"）。
 * 为什么 dm 不与 comment 共用 QUOTA_PARK_MAX_MS（3 小时）：comment 的停牌是"额度满了等它恢复"，
 *   越短越划算（每停一次就探一次）；dm 的 21046 是**平台给定的显式 24 小时禁令**，
 *   提前试探等于连续撞墙，还会把 45→90→180 的递增退避白白拉长。
 * 天花板仍是 nextQuotaReset（00:05）—— 平台禁令若真的按自然日刷新，压在午夜之后就是白等。
 */
export const QUOTA_PARK_MAX_MS_DM = 24 * 60 * MIN
/** 上次停牌**结束**后过了这么久没再犯，就重新从 45 分钟起算（不然一天里越滚越长） */
export const QUOTA_STRIKE_DECAY_MS = 2 * 60 * MIN

/**
 * 本地时区的"下一个 00:05" —— 只当**天花板**用（停牌绝不允许越过它）。
 * ⚠️ B站 的评论额度按自然日算，但**不保证零点那一秒就立刻放行**（10-21 实测：前一天 290 条
 *    把额度打满后，第二天上午 10 点还在报 12014）—— 所以它只是"最晚也就等到这儿"的保守上限。
 */
export const nextQuotaReset = (now = Date.now()) => {
  const d = new Date(now)
  d.setHours(0, 5, 0, 0)
  let until = d.getTime()
  while (until <= now) {
    d.setDate(d.getDate() + 1)
    until = d.getTime()
  }
  return until
}

/**
 * 第 n 次撞额度时停多久：45min → 90min → 180min（封顶 3h）。
 * ⭐ dm 桶封顶改成 24 小时（QUOTA_PARK_MAX_MS_DM）：21046 的平台原话就是"请在24小时后再发"。
 *   ⚠️ 但 dm 的**递增**不适用：45→90→180 是"试探额度恢复了没"的退避，而 21046 是平台给的
 *   显式 24 小时禁令 —— 提前试探等于连续撞墙。所以 dm 首次就停 24 小时，不递增。
 *   bucket 缺省按 comment 走旧行为（只增不破）。
 */
export const quotaParkMs = (strikes = 1, bucket = 'comment') => {
  const n = Math.max(1, Math.min(6, Math.round(num(strikes, 1))))
  if (bucket === 'dm') return QUOTA_PARK_MAX_MS_DM
  return Math.min(QUOTA_PARK_MS * 2 ** (n - 1), QUOTA_PARK_MAX_MS)
}

/** 这次停到什么时候：短停，但绝不越过下一个 00:05 */
export const quotaParkUntil = (now = Date.now(), strikes = 1, bucket = 'comment') =>
  Math.min(now + quotaParkMs(strikes, bucket), nextQuotaReset(now))

/** 账本里 recent 最多留多少条（2 小时窗口足够算 burst 与 hour，多了只是占地方） */
const RECENT_MAX = 200
/** recent 的裁剪窗口：比最大的 hour 窗口（1 小时）宽一倍，留点余量 */
const RECENT_KEEP_MS = 2 * 60 * MIN

const num = (v, dflt = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/**
 * 把 state.json 里那个 `pace` 键读成**一定是合法形状**的书。
 * 脏数据（手改坏了、老版本写的、null）一律当空书 —— 节奏闸宁可放宽也不许让插件卡死。
 */
export const paceBook = (raw) => {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const last = {}
  const rawLast = src.last && typeof src.last === 'object' && !Array.isArray(src.last) ? src.last : {}
  for (const kind of PACE_KINDS) {
    const v = rawLast[kind]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const at = num(v.at)
      const next = num(v.next)
      if (at > 0) last[kind] = { at, next: next > at ? next : at }
    } else if (num(v) > 0) {
      // 兼容更早的"直接存时间戳"写法
      last[kind] = { at: num(v), next: num(v) }
    }
  }
  const recent = (Array.isArray(src.recent) ? src.recent : [])
    .map((x) => (x && typeof x === 'object' ? { k: String(x.k || ''), t: num(x.t) } : null))
    .filter((x) => x && x.t > 0 && PACE_KINDS.includes(x.k))
    .slice(-RECENT_MAX)
  // 额度停牌：{comment: <untilMs>}，只按桶记，跟风控的 cooldownUntil 是两码事
  // strikes 是"连着撞了几次额度" —— 用来让停牌时长递增（45min → 90min → 180min）
  const quota = {}
  const quotaStrikes = {}
  const rawQuota = src.quota && typeof src.quota === 'object' && !Array.isArray(src.quota) ? src.quota : {}
  const rawStrikes = src.quotaStrikes && typeof src.quotaStrikes === 'object' && !Array.isArray(src.quotaStrikes) ? src.quotaStrikes : {}
  for (const bucket of Object.keys(QUOTA_SCOPES)) {
    const at = num(rawQuota[bucket])
    if (at > 0) quota[bucket] = at
    const n = Math.round(num(rawStrikes[bucket]))
    if (n > 0) quotaStrikes[bucket] = n
  }
  return {
    last,
    recent,
    quota,
    quotaStrikes,
    cooldownUntil: Math.max(0, num(src.cooldownUntil)),
    cooldownWhy: String(src.cooldownWhy || ''),
    cooldownCode: String(src.cooldownCode || ''),
  }
}

/** 把窗口外的老记录剪掉（每次算之前都剪一次，账本永远不会无限长） */
const prune = (book, now) => {
  const cut = now - RECENT_KEEP_MS
  const recent = book.recent.filter((x) => x.t >= cut).slice(-RECENT_MAX)
  return { ...book, recent }
}

/**
 * 现在能不能发 `kind`？
 * @returns {{ok:true, at:number}} 或者
 *          {{ok:false, reason:'cooldown'|'burst'|'hour'|'gap', waitMs:number, retryAt:number,
 *            used?:number, cap?:number, label:string, hint:string}}
 *
 * ⚠️ 返回的是"多久之后能发"，不是"该不该发" —— 该不该是模型自己判断的事（使用者第 2 条：
 *    别把行为限制死）。这里只保证"别像机器"这一条底线。
 */
export const paceCheck = (rawBook, kind, now = Date.now()) => {
  const spec = PACE[kind]
  if (!spec) return { ok: true, at: now }
  const book = prune(paceBook(rawBook), now)
  const label = spec.label, gates = []

  // ① 冷却：被风控打过就整体停
  if (book.cooldownUntil > now) {
    const waitMs = book.cooldownUntil - now
    gates.push({
      ok: false, reason: 'cooldown', waitMs, retryAt: book.cooldownUntil, label,
      hint: `刚被 B站 拦了一下${book.cooldownCode ? `（${book.cooldownCode}）` : ''}，`
        + `整体歇 ${Math.ceil(waitMs / MIN)} 分钟再说 —— 这条不是"慢一点"，是"先别动"。`,
    })
  }

  // ② 额度停牌：不是"太快"，是**这件事暂时没额度了**，硬试只会白挨
  const qBucket = quotaBucketOf(kind)
  const qUntil = qBucket ? Math.max(0, num(book.quota[qBucket])) : 0
  if (qUntil > now) {
    const waitMs = qUntil - now
    gates.push({
      ok: false, reason: 'quota', waitMs, retryAt: qUntil, label,
      hint: `B站 说这个号的${qBucket === 'comment' ? '评论' : qBucket}额度满了（12014）—— `
        + '不是被风控，是额度没了，现在试也一样；到点会自动再探一次。',
    })
  }

  // ③ 连发：10 分钟里条数太多，整体刹车
  const burstFrom = now - BURST.windowMs
  const inBurst = book.recent.filter((x) => x.t >= burstFrom)
  if (inBurst.length >= BURST.max) {
    // 最早的那条滑出窗口的时刻 = 可以再发一条的时刻
    const slideAt = inBurst[inBurst.length - BURST.max].t + BURST.windowMs
    const retryAt = slideAt + (inBurst.length >= BURST.max + 3 ? BURST.extraWaitMs : 0)
    /* ⚠️ 判据是 `retryAt > now`，不是 `inBurst.length >= BURST.max` 本身：
       条数够 6 条、但最早那条正好在窗口边上滑出去的那一刻，waitMs 会是 0 ——
       那时再拦就是「说还要等 0 秒」，摘要（按 freeAt>now 算）会说能发，两边打架。
       （2026-10-21 一致性断言抓到的，就是这一处。） */
    if (retryAt > now) {
      gates.push({
        ok: false, reason: 'burst', waitMs: retryAt - now, retryAt, label,
        used: inBurst.length, cap: BURST.max,
        hint: `${Math.round(BURST.windowMs / MIN)} 分钟里已经发了 ${inBurst.length} 条了，`
          + '这么密像机器 —— 歇几分钟，回去翻翻视频、写写日报。',
      })
    }
  }

  // ④ 小时上限（只看同类）
  const hourFrom = now - 60 * MIN
  const inHour = book.recent.filter((x) => x.k === kind && x.t >= hourFrom)
  if (inHour.length >= spec.hour) {
    const freeAt = inHour[inHour.length - spec.hour].t + 60 * MIN
    // 同上：只在「真的还没到点」时拦（freeAt 恰好等于 now 时应该放行）
    if (freeAt > now) {
      gates.push({
        ok: false, reason: 'hour', waitMs: freeAt - now, retryAt: freeAt, label,
        used: inHour.length, cap: spec.hour,
        hint: `这一小时已经${label} ${inHour.length} 次了（上限 ${spec.hour}）—— 到点了再继续，`
          + '别一口气把今天的量刷完。',
      })
    }
  }

  // ⑤ 最小间隔（带抖动）
  const prev = book.last[kind]
  if (prev && now < prev.next) {
    const waitMs = prev.next - now
    gates.push({
      ok: false, reason: 'gap', waitMs, retryAt: prev.next, label,
      hint: `上一次${label}才过了一会儿 —— 再等 ${Math.ceil(waitMs / 1000)} 秒，别急。`,
    })
  }
  if (!gates.length) return { ok: true, at: now }
  // Keep hard-gate priority for force handling, but never promise an earlier retry than another active gate allows.
  const first = gates[0], retryAt = Math.max(...gates.map(gate => gate.retryAt))
  return { ...first, retryAt, waitMs: retryAt - now,
    ...(retryAt > first.retryAt ? { hint: first.hint + ` 还有其他节奏限制，本类动作合计还需等 ${Math.ceil((retryAt - now) / 1000)} 秒。` } : {}) }
}

/**
 * 记一次"我真的发出去了"。
 * ⚠️ 只该在**确认成功之后**调：失败也记的话，会让后面本来能发的动作被无谓地往后推。
 * ⚠️ 这里把"下次最早什么时候"一次钉死（gap + 随机抖动），而不是每次 check 现算 ——
 *    现算的话，模型反复 check 就会看到倒计时忽长忽短，像坏了。
 *
 * @param {number} rand 0..1 的随机数（测试里注入固定值）
 */
export const paceTake = (rawBook, kind, now = Date.now(), rand = Math.random()) => {
  const spec = PACE[kind]
  const book = prune(paceBook(rawBook), now)
  if (!spec) return book
  // ⚠️ 默认值必须写成 `Math.random()` 带括号。写成 `= Math.random` 时传进来的是**函数本身**，
  //    num(函数) 是 NaN ⇒ 落到兜底 0 ⇒ 抖动恒为 0，每次都精确间隔 —— 正好是这一行本来要避免的机器特征。
  const r = Math.min(1, Math.max(0, num(rand, 0)))
  const next = now + spec.gap + Math.round(spec.jitter * r)
  return {
    ...book,
    last: { ...book.last, [kind]: { at: now, next } },
    recent: [...book.recent, { k: kind, t: now }].slice(-RECENT_MAX),
  }
}

/**
 * 远端回了"被风控"，记一笔冷却。
 * @param code B站 的返回码（-352 / -412 / …，数字或字符串都行）
 * @returns 新的书 + `cooled`（这次有没有真的进冷却，好让调用方把话说清楚）
 *
 * ⚠️ 冷却取**两者更久的那个**：已经有一小时冷却，又来一个 20 分钟的，不该把它缩短。
 */
export const paceNoteRisk = (rawBook, code, now = Date.now()) => {
  const book = prune(paceBook(rawBook), now)
  const key = String(code ?? '').trim()

  // 额度码：只停它管的那些桶，**别升级成全局冷却**（不然连私信/动态一起停了）
  const bucket = QUOTA_CODES[key]
  if (bucket) {
    const prev = num(book.quota[bucket])
    // 上一轮停牌早就结束了、而且之后一直没再犯 ⇒ 重新从 45 分钟起算，别把一天里的小插曲滚成雪球
    const prevStrikes = num(book.quotaStrikes?.[bucket])
    const decayed = prev > 0 && now - prev > QUOTA_STRIKE_DECAY_MS
    const strikes = (decayed ? 0 : prevStrikes) + 1
    const until = quotaParkUntil(now, strikes, bucket)
    return {
      book: {
        ...book,
        quota: { ...book.quota, [bucket]: Math.max(prev, until) },
        quotaStrikes: { ...(book.quotaStrikes || {}), [bucket]: strikes },
      },
      cooled: until > prev,
      quota: true,
      bucket,
      strikes,
      waitMs: Math.max(0, until - now),
      code: key,
    }
  }

  const ms = RISK_COOLDOWN[key] || 0
  if (!ms) return { book, cooled: false, waitMs: 0, code: key }
  const until = Math.max(book.cooldownUntil, now + ms)
  return {
    book: { ...book, cooldownUntil: until, cooldownWhy: `风控 ${key}`, cooldownCode: key },
    cooled: until > book.cooldownUntil,
    waitMs: Math.max(0, until - now),
    code: key,
  }
}

/**
 * 给界面 / `bili_pace` 工具看的一眼摘要。
 *
 * ⚠️ 它**不参与判断**（判断在 paceCheck），但**绝不许撒谎**：
 *   2026-10-21 注入 6 条 recent 做真机测试时发现，早先这版只按 `last[kind].next` 算 waitSec，
 *   连发闸已经饱和、`paceCheck` 五类全 BLOCKED，摘要却还报「现在可以发」——
 *   模型照着摘要去发，被闸门拦回来，白烧一轮 token（而且它会以为闸门坏了）。
 *   ⇒ 每一类给出的 `waitSec` 必须是**所有约束里最晚那个**决定的，与 paceCheck 同一套逻辑。
 *
 * 返回每一类：gapSec/jitterSec（展示口径，受 factor 缩放）、hourCap、usedThisHour、
 *            nextAt/waitSec（**真实可发时刻**）、blockedBy（cooldown|quota|burst|hour|gap|''）。
 */
export const paceSummary = (rawBook, now = Date.now(), factor = 1) => {
  const book = prune(paceBook(rawBook), now)
  const f = Math.min(3, Math.max(0.3, num(factor, 1)))

  // 连发闸是**整体**约束，所有类型共用同一个解禁时刻 ⇒ 先算一次
  const inBurstRows = book.recent.filter((x) => x.t >= now - BURST.windowMs)
  let burstFreeAt = 0
  if (inBurstRows.length >= BURST.max) {
    const freeAt = inBurstRows[inBurstRows.length - BURST.max].t + BURST.windowMs
    burstFreeAt = Math.max(freeAt, now) + (inBurstRows.length >= BURST.max + 3 ? BURST.extraWaitMs : 0)
  }
  const coolAt = book.cooldownUntil > now ? book.cooldownUntil : 0

  const kinds = {}
  for (const kind of PACE_KINDS) {
    const spec = PACE[kind]
    const prev = book.last[kind]
    // factor 只影响**展示口径**：真正钉在 last.next 里的时间是当时用当时的 factor 算的。
    // 想让它立刻变快/变慢，得等当下这一条发出去（那一下会按新 factor 重钉）。
    const gapAt = prev ? prev.next : 0
    const inHour = book.recent.filter((x) => x.k === kind && x.t >= now - 60 * MIN)
    const hourAt = inHour.length >= spec.hour ? inHour[inHour.length - spec.hour].t + 60 * MIN : 0
    // 额度停牌只影响它管的那几类（评论桶拦评论，不拦私信/动态）
    const qBucket = quotaBucketOf(kind)
    const quotaAt = qBucket && num(book.quota[qBucket]) > now ? num(book.quota[qBucket]) : 0
    // 真正能发的时刻 = 所有约束里最晚的那个（顺序与 paceCheck 一致：冷却 > 额度 > 连发 > 小时 > 间隔）
    const freeAt = Math.max(gapAt, burstFreeAt, hourAt, coolAt, quotaAt, now)
    kinds[kind] = {
      label: spec.label,
      gapSec: Math.round((spec.gap / 1000) * f),
      jitterSec: Math.round((spec.jitter / 1000) * f),
      hourCap: spec.hour,
      usedThisHour: inHour.length,
      nextAt: freeAt > now ? new Date(freeAt).toISOString() : '',
      waitSec: Math.max(0, Math.ceil((freeAt - now) / 1000)),
      blockedBy: coolAt > now ? 'cooldown'
        : quotaAt > now ? 'quota'
          : burstFreeAt > now ? 'burst'
            : hourAt > now ? 'hour'
              : gapAt > now ? 'gap'
                : '',
    }
  }
  const quotaOut = {}
  for (const [bucket, until] of Object.entries(book.quota)) {
    if (until > now) {
      quotaOut[bucket] = {
        until: new Date(until).toISOString(),
        waitSec: Math.ceil((until - now) / 1000),
        kinds: QUOTA_SCOPES[bucket] || [],
        // 连着撞了几次 + 这次停多少分钟（界面/模型据此说"还会越停越久"）
        strikes: Math.round(num(book.quotaStrikes?.[bucket])),
        parkMin: Math.round((until - now) / MIN),
        maxParkMin: Math.round(QUOTA_PARK_MAX_MS / MIN),
      }
    }
  }
  return {
    kinds,
    burst: {
      windowMin: Math.round(BURST.windowMs / MIN),
      max: BURST.max,
      used: inBurstRows.length,
      // 摘要里直接给"连发闸什么时候松开"，免得前端自己再算一遍
      freeAt: burstFreeAt > now ? new Date(burstFreeAt).toISOString() : '',
    },
    quota: Object.keys(quotaOut).length ? quotaOut : null,
    cooldown: book.cooldownUntil > now
      ? { until: new Date(book.cooldownUntil).toISOString(), waitSec: Math.ceil((book.cooldownUntil - now) / 1000), why: book.cooldownWhy, code: book.cooldownCode }
      : null,
    recentCount: book.recent.length,
  }
}

/**
 * 给设置页与工具解释「系数调了什么、没有调什么」。纯描述，不写配置、不改账本。
 * effective* 是下一次成功发送时要钉下的间隔范围，不是当前动作保证能发的时刻；
 * 当前等待直接复用 paceSummary，保留既有 last.next、小时/连发闸、额度与风控。
 */
export const paceExplain = (rawBook, now = Date.now(), factor = 1) => {
  const f = Math.min(3, Math.max(0.3, num(factor, 1)))
  const summary = paceSummary(rawBook, now, f)
  const kinds = {}
  for (const kind of PACE_KINDS) {
    const spec = PACE[kind]
    kinds[kind] = {
      ...summary.kinds[kind],
      baseGapSec: spec.gap / 1000,
      baseJitterSec: spec.jitter / 1000,
      baseMinSec: spec.gap / 1000,
      baseMaxSec: (spec.gap + spec.jitter) / 1000,
      effectiveGapSec: Math.round(spec.gap * f) / 1000,
      effectiveJitterSec: Math.round(spec.jitter * f) / 1000,
      effectiveMinSec: Math.round(spec.gap * f) / 1000,
      effectiveMaxSec: Math.round((spec.gap + spec.jitter) * f) / 1000,
      quotaBucket: quotaBucketOf(kind),
      hourWindowSec: 60 * MIN / 1000,
      hourCapScalesWithFactor: false,
    }
  }
  return {
    factor: f,
    presets: { ...PACE_PRESETS },
    kinds,
    factorAffects: 'next-success-gap-only',
    pinnedIntervalsPreserved: true,
    burst: {
      ...summary.burst,
      windowSec: BURST.windowMs / 1000,
      extraWaitSec: BURST.extraWaitMs / 1000,
      extraAfterCount: BURST.max + 3,
      scope: 'all',
      scalesWithFactor: false,
    },
    quota: {
      codes: { ...QUOTA_CODES },
      scopes: Object.fromEntries(Object.entries(QUOTA_SCOPES).map(([bucket, scope]) => [bucket, [...scope]])),
      parkSec: [1, 2, 3].map((strikes) => quotaParkMs(strikes) / 1000),
      maxParkSec: QUOTA_PARK_MAX_MS / 1000,
      strikeDecaySec: QUOTA_STRIKE_DECAY_MS / 1000,
      resetCeiling: '00:05 local time',
      scalesWithFactor: false,
      active: summary.quota
        ? Object.fromEntries(Object.entries(summary.quota).map(([bucket, entry]) => [bucket, { ...entry, kinds: [...entry.kinds] }]))
        : null,
    },
    risk: {
      cooldownSecByCode: Object.fromEntries(Object.entries(RISK_COOLDOWN).map(([code, ms]) => [code, ms / 1000])),
      scope: 'all',
      scalesWithFactor: false,
      active: summary.cooldown,
    },
    notes: {
      interval: '系数只调整下一次成功发送后钉下的基础间隔与随机抖动；已钉下的等待不会重算。',
      hour: '滚动一小时的各类上限不随系数改变；间隔到了也可能仍需等小时闸。',
      burst: '所有发送类型共用滚动连发闸，不随系数改变；不是每到整十分钟刷新。',
      quota: '12014 只停视频新评论与视频回复，不停动态评论、私信或发动态；额度停牌不随系数缩短。',
      risk: '明确风控码触发所有发送类型冷却，已有更长冷却不会缩短；调快系数不能解禁。',
      safety: '预设是本地节奏偏好，不是 B站 承诺的安全频率；不会自动覆盖已保存的系数。',
    },
  }
}

/**
 * 把一次"被节奏闸挡住"翻译成给模型看的话 —— 三件事都要说清：
 * ① 现在不能发（别硬来）② 还有多久 ③ **这段时间该去干什么**（不是干等着）。
 * 最后那条最要紧：只告诉它"不许"会让它停在原地空转，白烧 token。
 */
export const paceHint = (res, kind) => {
  const spec = PACE[kind]
  const label = spec ? spec.label : String(kind || '这个动作')
  const sec = Math.max(1, Math.ceil(num(res?.waitMs) / 1000))
  const wait = sec >= 90 ? `${Math.ceil(sec / 60)} 分钟` : `${sec} 秒`
  const tail = res?.reason === 'cooldown'
    ? '这段时间别试探性地再发 —— 风控是**越试越久**的。'
    : res?.reason === 'quota'
      ? '额度不是手速问题，到点会自动再探一次；这段时间先去回私信、刷弹幕、翻字幕、写日报。'
      : '这段时间去干不用发东西的活：翻字幕、看评论、写日报、翻别人给你说了什么。'
  return `${label}先缓一缓：还要等 ${wait}（${res?.hint || '节奏闸'}）${tail}`
}
