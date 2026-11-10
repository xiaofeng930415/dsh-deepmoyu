/**
 * lib/dm.mjs —— 私信「这一条该不该回」的**判据唯一来源**（纯函数：不碰网络、不碰磁盘）
 * ============================================================================
 * 为什么要抽出来（2026-10-20）：
 *   同一条判据要在**三处**给出同一个答案 ——
 *     ① `bili_dm_inbox` 的返回里，每条标 `can_reply` / `skip_reason`；
 *     ② `bili_dm_reply` **发送前**拿最新收件箱态再复核一遍（闸门四）；
 *     ③ 提示词与设置页文案里，对使用者解释"为什么不回"。
 *   三处各写一遍 ⇒ 迟早会漂。而私信这条链路的后果不是"界面难看"，是**拿使用者的号
 *   去跟真人说话**：判重漏一条 = 对着同一个人刷屏；额度漏一条 = 追着一个人聊；
 *   陌生人漏一条 = 回陌生人。⇒ 只留这一份，三处都来这儿取答案。
 *
 * ⭐ 2026-10-21（使用者原话）：「也不用限制他每天能回多少句」——
 *   **每人每天的条数上限整个删掉了**（原来那条判据在 ②，`dmReplyPerDay`）。
 *   现在拦着的只有三件：回过了 / 陌生人不回 / 晾太久。
 *   想不想回、回几句，是她自己的事；节奏由 `lib/pace.mjs` 管（防风控，不是配额）。
 *
 * 不变量（改之前先读）：
 *   · 返回值 **空串 = 可以回**；非空 = 给模型看的一句人话，说清为什么不用回。
 *     宿主的用法一律是 `can_reply: skip === ''` —— 空串必须是唯一的"放行"信号，
 *     所以任何"只是提醒一下"的话都不许从这里返回。
 *   · 三条判据的**先后顺序是有意的**（见 dmSkipReason 里的注释）：
 *       回过了 → 陌生人 → 晾太久
 *     顺序只影响 `skip_reason` 的文案：同时踩两条时，先说那条**最不可逆**的。
 *   · `dmRemember` **绝不改入参**：`state.json` 读出来的对象在 `withStateLock` 里
 *     还挂着别的引用，就地变异会变成静默的数据丢失。
 *
 * ⚠️ 这里**不管**两件事，因为它们在上游就滤掉了：
 *   · "对方最后一句不是他说的" —— `vendor/bilibili-mcp/mcp_server.py` 的
 *     `bili_dm_list` 只报 `last_msg.sender_uid === talker_id` 的会话（回完自动从列表消失）；
 *   · 系统号 / 官方号 / 非文本消息 —— 同一处按 `session_type` / `system_msg_type` 滤掉。
 */

/**
 * 「晾太久」的天数：对方最后一句距今**超过**这么多天就不回了。
 * ⭐ 数值 3 必须与 `client.js` 里的 `DM_STALE_DAYS` 一致（设置页文案要念这个数），
 *    `devtools/check-dm.cjs` 会把两处钉在一起对账。
 * 为什么是 3 而不是 7：私信是即时对话，晾了一周再回"你好呀"只会让人觉得诡异；
 * 3 天以内还算"接话"，超过就等对方再找你。
 */
import { normalizeId, readableId } from './ids.mjs'

export const DM_STALE_DAYS = 3

/**
 * 判重账本（`state.json` 的 `dmReplied`）最多记多少条。
 * 一条 = 回过的一条私信，1000 条已经远超正常人一辈子的私信量；
 * 上限存在的意义只是**防止账本无限长**（老账本里还有早期版本写进去的垃圾键）。
 * 超了按记录时间砍最早的 —— 砍掉的只是"很久以前回过的"，不影响近期判重。
 */
export const DM_LEDGER_MAX = 1000

/** 把各种可能的值收敛成一个"能当数字用"的非负数（NaN / 负数 / 字符串都在这里归零） */
const toCount = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 这一条私信该不该回。
 *
 * @param {object} it     `bili_dm_list` 的一条：
 *                        `{ uid, name, said, msg_seqno, time, time_str, days_ago, unread, is_follow }`
 * @param {object} cfg    配置（只认 `dmReplyFollowedOnly`）
 * @param {object} [was]  判重结果：账本里已经有这个 msg_seqno 时传 `{ at }`（回过的时刻，可能为空）
 * @returns {string} 空串 = 可以回；非空 = 给模型看的中文理由
 *
 * ⚠️ 2026-10-21（使用者原话）：「也不用限制他每天能回多少句」
 *    ⇒ **每人每天的条数上限整个删掉了**。这里再也没有「额度」这个概念 ——
 *      想回几条回几条，唯一拦着的是「这条回过了」「陌生人不回」「晾太久」，
 *      剩下的交给 `lib/pace.mjs` 的出手节奏（那是防风控，不是配额）。
 *
 * 判据顺序（**改动前想清楚为什么**）：
 *   ① 回过了    —— 永久事实，换一天也不会变，最先说模型才不会反复试。
 *   ② 陌生人    —— 设置里开着「只回我关注的人」而对方不在关注列表。
 *   ③ 晾太久    —— 放最后：`days_ago` 是上游算出来的，可能缺失/算错，
 *                  误判成"太旧"会让一条本来能回的消息被永久跳过 ⇒ 宁可最后才拦。
 *   ④ 关系门等  —— 2026-11-10 新增（规格 #1751 E）：撞过 21047 且对方还没开口。
 *                  放在最后：它是"暂时"的（对方回一句就解锁），而前三者要么永久要么是设置。
 * ⭐ 配置参数（`cfg`）除 `dmReplyFollowedOnly` 外，还认 `dmGateWaiting`
 *   （`state.json` 的同名字段，宿主原样透传）—— 保持"判据只此一份"：收件箱标注、
 *   发送前复核、测试三处都调这一个函数。
 */
export const dmSkipReason = (it, cfg, was) => {
  const item = it && typeof it === 'object' ? it : {}
  const conf = cfg && typeof cfg === 'object' ? cfg : {}
  try {
    normalizeId(item.uid, { allowZero: false })
    normalizeId(item.msg_seqno, { allowZero: false })
  } catch {
    return '这条私信的 uid/msg_seqno 缺失、无效或是不安全的 number —— 不猜测收件人或回复对象。'
  }

  /* ① 判重：同一个 `msg_seqno` 只回一次。
   * 私信判重是"一次来往回一条" —— 对方再发新的就是新的 seqno，账本不会挡。
   * 文案里必须带上 seqno：模型照着它才知道"是这条回过了"，换下一条去回。 */
  if (was && typeof was === 'object') {
    const seq = String(item.msg_seqno ?? '')
    const at = String(was.at || '')
    return `这条私信（msg_seqno=${seq}）${at ? `在 ${at} ` : ''}已经回过了 —— 不用再回一遍。`
      + '换下一条 `can_reply=true` 的。'
  }

  /* ② 陌生人不回（默认开）。
   * `is_follow` 缺失时按"没关注"处理：宁可少回一条，也不拿使用者的号去回陌生人。
   * 开关关掉（`dmReplyFollowedOnly` 为假）就整条跳过 —— 测试里"关掉 ⇒ 陌生人也放行"钉着这点。 */
  if (conf.dmReplyFollowedOnly && !item.is_follow) {
    return '这人你没关注（设置里开着「只回我关注的人」）—— 陌生私信一律不回，别把私信当聊天通道。'
  }

  /* ③ 晾太久不回。`days_ago` 缺失 / 不是数字 ⇒ **不判**（宁可回一条旧消息，也不误杀新消息）。 */
  if (item.days_ago !== undefined && item.days_ago !== null) {
    const days = Number(item.days_ago)
    if (Number.isFinite(days) && days > DM_STALE_DAYS) {
      return `这条私信晾了 ${Math.floor(days)} 天了（超过 ${DM_STALE_DAYS} 天就不回了）`
        + ' —— 旧消息不去翻，等对方再找你。'
    }
  }

  /* ④ 关系门等待中（2026-11-10，规格 #1751 E 段）。
   *    平台返回 21047「对方主动回复或关注你前，最多发送1条消息~」后，宿主把这个 uid 记进
   *    `state.json` 的 `dmGateWaiting`。判据仍然只此一份：这里放行 = 对方已经开口了
   *    （`waitingSeqno` 不是当前这条 ⇒ 有新消息进来 ⇒ 解锁）。
   *    ⚠️ 为什么放在 dmSkipReason 而不是只在发送链里判：收件箱也要标出来，
   *      不然模型看着 `can_reply=true` 去发，发的瞬间才被平台打回，白烧一轮。 */
  const waiting = conf.dmGateWaiting && typeof conf.dmGateWaiting === 'object' && !Array.isArray(conf.dmGateWaiting)
    ? conf.dmGateWaiting[String(item.uid ?? '')]
    : null
  if (waiting && typeof waiting === 'object') {
    const current = String(item.msg_seqno ?? '')
    const held = String(waiting.seqno ?? '')
    // 同一条 seqno 还在等 ⇒ 关系门还没开；换了 seqno ⇒ 对方开口了 ⇒ 放行。
    if (!held || held === current) {
      const at = String(waiting.at || '')
      return `这条（msg_seqno=${current}）${at ? `在 ${at} ` : ''}撞过关系门（21047）：`
        + '对方主动回复或关注之前，这个号只能收到我们一条消息。等他开口再回，别换措辞重试。'
    }
  }

  return ''
}

/**
 * 记一笔判重账本。返回**新对象**，不改入参。
 *
 * @param {Record<string, object>} ledger  `state.json` 的 `dmReplied`
 * @param {string} key   判重钥匙（宿主传 `dm:<seqno>`，老账本里是裸 seqno）
 * @param {object} rec   `{ uid, at, seqno }`
 * @returns {Record<string, object>}
 *
 * ⚠️ 钥匙是 `'0'` 或空 ⇒ **不记**。seqno=0 表示"没填"，记下去会让同一个"0"把
 *   所有没填 seqno 的私信认成同一条（要么全挡、要么账本被垃圾键填满），
 *   而且下次真的回了别人也查不出来。宁可漏记，也不写垃圾。
 */
export const dmRemember = (ledger, key, rec) => {
  const next = { ...(ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}) }
  const k = typeof key === 'string' ? key.trim() : ''
  const match = /^dm:([0-9]+):([0-9]+)$/.exec(k)
  if (!match) return next
  const uid = readableId(match[1], { allowZero: false })
  const seq = readableId(match[2], { allowZero: false })
  if (!uid || !seq) return next
  if ((rec?.uid !== undefined && readableId(rec.uid, { allowZero: false }) !== uid)
      || (rec?.msg_seqno !== undefined && readableId(rec.msg_seqno, { allowZero: false }) !== seq)
      || (rec?.seqno !== undefined && readableId(rec.seqno, { allowZero: false }) !== seq)) return next
  next[`dm:${uid}:${seq}`] = { ...rec, uid, msg_seqno: seq }
  const keys = Object.keys(next)
  if (keys.length > DM_LEDGER_MAX) {
    // 按记录时间砍最早的。没 `at` 的排最后（`'9999'`）⇒ 它们最晚被砍，优先保住。
    keys
      .sort((a, b) => String(next[a]?.at || '9999').localeCompare(String(next[b]?.at || '9999')))
      .slice(0, keys.length - DM_LEDGER_MAX)
      .forEach((x) => delete next[x])
  }
  return next
}

/**
 * 今天回过这个人几条。**跨天自动归零** —— 这就是"每人每天"的落地点。
 *
 * @param {object} state 整份 `state.json`（只读 `dmPerUser`）
 * @param {number|string} uid 对方 UID
 * @param {string} day   今天的 key（宿主传 `dayKey()`，形如 `2026-10-20`）
 * @returns {number}
 *
 * 为什么把 `day` 当参数而不是在这里取当前日期：纯函数才能被离线测试钉住
 * （`devtools/check-dm.cjs` ⑦ 就是拿固定的两天验跨天归零）。
 */
export const dmSentToday = (state, uid, day) => {
  const book = state && typeof state === 'object' ? state.dmPerUser : null
  if (!book || typeof book !== 'object' || Array.isArray(book)) return 0
  const rec = book[String(uid)]
  if (!rec || typeof rec !== 'object') return 0
  // 记录的日期对不上 ⇒ 是昨天（或更早）的计数，今天从 0 开始
  if (String(rec.day ?? '') !== String(day ?? '')) return 0
  return toCount(rec.n)
}
