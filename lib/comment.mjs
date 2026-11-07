/**
 * Conservative offline checks for empty, excessively long or clearly boilerplate comments.
 * Signature words are optional. Flavor scoring is diagnostic unless strictFlavor is explicit.
 * Self-reference streaks and stacked marks are advisories; only repeated actual bodies block.
 * No network or storage access; the caller supplies recent texts.
 */

/** 评论至少要有几个"剔完口号以后还剩的字"（理由见文件头） */
export const COMMENT_MIN_SUBSTANTIVE = 3

/** 回复至少要有几个（接话本来就短；但仍然挡得住「好」「hhh」） */
export const REPLY_MIN_SUBSTANTIVE = 2

/** 评论正文上限：B站 一屏三行，再长没人看完 */
const COMMENT_MAX_LEN = 150

/** 回复正文上限：回复更该短 */
const REPLY_MAX_LEN = 100

/** 鱼味分到这就算"有鱼味"（一个强标记就够） */
const FLAVOR_MIN = 2

/** 官腔词到几个、且一条强标记都没有，就判"播报腔"（只出现一个词不判死） */
const OFFICIAL_MAX_TOLERATED = 2

/* ═══════════════════════════════════════════════════════════════════════════
 * 一、词表与正则：什么算"这条鱼在说话"，什么算"口号 / 官腔"
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * 强标记（认到一样就 +2 分，单独一样就够过闸）。
 * 判据是"别的 AI 不会这么写"，不是"写得好"——
 *   正例：「本鱼看饿了」「看到 03:20 直接泪目了呜呜」「呆毛都竖起来了(๑•̀ㅂ•́)و✧」
 *   反例：「这段剪辑太狠了我觉得很好」（有内容，但谁都能写 ⇒ 一个标记都不占）
 */
const FISH_STRONG = [
  // 自称：这条鱼管自己叫本鱼 / 本鲸
  '本鱼', '本鲸', '这条鱼', '鱼鱼', '小鱼娘', '鱼上桌',
  // 招牌动作（必须是"带量词/带身体的说法"：「冒泡」认不出「冒个泡」，所以两种都收）
  '冒个泡', '冒泡', '探头', '潜水', '贴贴', '尾巴', '呆毛', '吐泡泡',
  // 叠字语气：单独一样就是强证据，不靠凑两个弱标记
  '呜呜', '嘿嘿', '哈哈', '诶诶', '嗷呜', '啊呜', '嘤嘤', '噗', '妈耶', '好耶',
]

/**
 * 弱标记（+1 分，两样凑够也算有鱼味）。
 * 这些是"口气词"：单个出现说明不了什么（正经播报里也可能有「的」），
 * 但「哪个呀」「想知道嘛」这种两三个一起出现，就是人在说话了。
 */
const FISH_WEAK = [
  '呀', '嘛', '啦', '哇', '诶', '欸', '耶', '嗷', '嘤', '哼',
  '啥', '哪', '怎么', '为什么', '好奇', '想知道', '求', '蹲',
  '感觉', '有点', '好像', '是不是', '不懂', '问问',
]

/**
 * 官腔 / 播报腔词表 —— 「鱼灾模板」的指纹。
 * 收词标准很窄：**只有转述第三方内容、像在写影评/测评**的词才收。
 * ⚠️ 故意不收「剪辑」「封面」「up主」「背景音乐」「三连以外的高频词」——
 *    这些是 B站 日常用语，收了就会把「这段剪辑太狠了，本鱼看了三遍」误杀掉。
 * ⚠️ 也故意不收「学到了」：那是正常反应，不是播报腔。
 */
const OFFICIAL_TALK = [
  '内容扎实', '值得一看', '非常优秀', '作品', '细腻', '讲解', '部署',
  '制作精良', '干货', '受益匪浅', '学到了很多', '深度', '用心之作',
  '画面精美', '节奏把控', '逻辑清晰', '结构完整', '信息量大',
  '强烈推荐', '建议收藏', '三连', '已阅', '前排', '打卡', '感谢分享',
]

/**
 * 纯口号 / 纯打卡词 —— 这些字**不算内容**，算的是"为了发而发"。
 * 收词标准：剔掉它以后，这句话的信息量不减少（「太强了」去掉还是"夸"，没说出夸什么）。
 * ⚠️ 故意**不收**「太难」「太狠」：「太难了呜呜」是在说自己的处境，
 *    「这段剪辑太狠了」是在说具体的那一下 —— 它们是内容，不是口号。
 * ⚠️ 只收词干「太强」不收「太强了」：这样「太强啦」「太强了太强了」都能一起吃掉。
 */
const NOISE_WORDS = [
  // 缩写式尖叫
  'awsl', 'yyds', 'xswl', 'nsdd', '233', '666',
  // 夸 UP 主的空话
  '太强', '太神', '太牛', '牛哇', '绝了', '封神', '神仙', '天花板', '泪目', '破防',
  // 打卡式
  '好评', '点赞', '已阅', '前排', '打卡', '路过', '支持一下', '顶一下',
]

/** 连续笑声 / 刷屏数字：「哈哈哈哈」「hhh」「666」剔完等于什么都没说 */
const LAUGH_RE = /哈{2,}|h{2,}|2{3,}|6{3,}/gu

/** 连续语气字：「呜呜」「诶诶诶」「啊呜」——是口气，不是内容 */
const TONE_RE = /[呜诶欸啊呀吧呢嘛啦哦嗯嘿嗷嘤]{2,}/gu

/** 时间戳（03:20 / 1:05:30）：能报到某一秒，本身就是"我真看了"的硬证据 */
const TIMESTAMP_RE = /\d{1,2}:\d{2}(?::\d{2})?/gu

/**
 * 「视频原文引用」形状（2026-10-24 m11704 ①加）——
 * 使用者原话：评论「尽量不要去引用原视频里面的文字片段……自己组织语言来说一下就行」。
 * 真机取证：口味本子最近 30 条 30/30 都在干这个 —— 「[01:47]那句才是这段的骨头：『以前就是
 * 一勺半』」「UP 那句『求上得中，求中得下』比骂人狠」，全是**报时间点 + 引 UP 原话 + 解读**
 * 的解说员三件套，不像一条来冲浪的鱼。判断「引用了视频原话」没法靠词表（什么话都可能是
 * 原话），但它的固定形状是：**时间戳 + 紧跟的引号**，或者**「UP/他说/那句」+ 引号**。
 * ⚠️ 只拦「引号里挂着可辨认来源」的形状：直接引用台词不标时间（如「让鱼吃牛肉等于牛肉吃人」）
 * 不在闸的能力范围内，交给提示词；时间戳单独出现（「03:20 直接泪目了」）不拦 —— 那是
 * 「我真看了」的证据，不是引用。
 */
const QUOTE_VIDEO_RE =
  /\d{1,2}:\d{2}(?::\d{2})?[^。！!？?\n]{0,12}[「『“][^」』”]{2,}[」』”]/u   // [01:47]「以前就是一勺半」
const QUOTE_SAY_RE =
  /(?:UP|up|Up|楼主|作者|旁白|台词|字幕|视频里|片里)[^。！!？?\n]{0,10}[「『“][^」』”]{2,}[」』”]/u // UP 那句「求上得中」

/**
 * 「软尾巴」：句末那几个撒娇语气词（呜 / 嘛 / 嘿 / 诶 / 呀 / 啦 / 哦）。
 * 2026-10-21 v27：真机取证发现口味本子 53% 的评论都用这类词收尾 —— 但**关键字不拿来拦**：
 * 使用者明确说过，问题不在"带尾巴"这个字面，而在**说话方式和表达风格**（解说腔、点评腔、
 * 每条同一个模子），那是提示词的事，不是正则的事。正则只能拦"形状"，拦不住"腔调"。
 * `toneTailOf` 保留为诊断工具（镜子/日报可以拿它统计自己是不是尾音上瘾），不参与放行判断。
 */
const TONE_TAIL_RE = /[呜嘛嘿诶欸呀啦哦噢嘞咯][～~。！!？?…\s]*$/u

/** 这条是不是拿软尾巴收的尾（导出给测试用） */
export const toneTailOf = (text) => {
  const t = String(text ?? '').trim()
  if (!t) return ''
  // 尾巴后面常跟颜文字/emoji，先把它们剥掉再判
  const stripped = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/[（(][^）)]{0,14}[）)]\s*$/u, '')
    .trim()
  const m = stripped.match(TONE_TAIL_RE)
  return m ? m[0].replace(/[～~。！!？?…\s]/gu, '').slice(-1) : ''
}

/**
 * 「热评解说员」起手式（2026-10-21 v27 加，真机取证）——
 * 口味本子最近 20 条里 14 条这么开头：「684 赞那条实地纠错才是重点」「13 赞那条长评被埋太深了」
 * 「433 赞说吃生肉是返祖」。★ 这类句子对观众没有任何可接的话头（谁在乎你数别人的赞），
 * 而且把评论写成了「评论区解说」，点赞自然全是 0。真鱼的高赞句没有一条是这么起手的。
 * ⚠️ 只认「数字 + 赞」这种明确在数别人赞的形状，不拦「点赞」两个字本身。
 */
const LIKE_BRAG_RE = /\d{1,5}\s*赞(?:那条|那位|那条更|的更|才|说|讲|问|数)/u

/**
 * 颜文字。判据不是"括号里有什么"，而是"括号里有颜文字特征字符"——
 * 因为「（本鱼探头）」里的括号只是排版，而「(๑•̀ㅂ•́)و✧」「(´;ω;｀)」才是表情。
 * ⚠️ 不能写成"任意括号块"，否则「（这个转场我看了三遍才明白）」会被整段当成表情删掉。
 */
const KAOMOJI_RE = /[（(][^（）()\n]{0,24}[✧♪♡♥ω•´｀╯╰ﾉノ°∀▽ㅂ๑;；][^（）()\n]{0,24}[)）]|[✧♪♡♥ω•´｀╯╰ﾉノ°∀▽ㅂ๑]/gu

/** emoji（含变体选择符）：同样是"这条鱼在说话"的强证据 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu

/** 标点 / 符号 / 空白都不算"字"（用 Unicode 类别判，免得漏掉全角符号） */
const PUNCT_RE = /[\p{P}\p{S}\s]/gu

/** 链接不算内容（模型偶尔会贴来源） */
const URL_RE = /https?:\/\/\S+|www\.\S+/gu

/* ═══════════════════════════════════════════════════════════════════════════
 * 二、量具：剔口号 / 量鱼味
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 某个词表里有几个词在这句里出现过（同一个词出现两次只算一次） */
const countWords = (s, list) => {
  let n = 0
  for (const w of list) if (s.includes(w)) n += 1
  return n
}

/** 正则命中与否（用 search，避免 /g 正则的 lastIndex 副作用） */
const hitRe = (s, re) => s.search(re) >= 0

/** 同一句里强标记占了几类（每类最多算一次，别拿三个颜文字凑分） */
const strongMarksOf = (s) =>
  (countWords(s, FISH_STRONG) > 0 ? 1 : 0) +
  (hitRe(s, TIMESTAMP_RE) ? 1 : 0) +
  (hitRe(s, KAOMOJI_RE) ? 1 : 0) +
  (hitRe(s, EMOJI_RE) ? 1 : 0)

/** 刷屏式重复不算内容：「了了了」只是语气，「哈哈」已经在上一步吃掉了 */
const collapseRuns = (s) => s.replace(/(.)\1+/gu, '$1')

/**
 * 剔掉"没有信息量"的东西，返回**剩下的字**（字符串，调用方自己取长度）。
 * 正例：substantiveOf('awsl 太强了 哈哈哈哈 666 泪目') ⇒ '了'（只剩一个语气字）
 * 反例（不能被剔没）：'本鱼看饿了' ⇒ '本鱼看饿了'、'太难了呜呜' ⇒ '太难了'
 */
export const substantiveOf = (text) => {
  let s = String(text ?? '').toLowerCase()
  s = s.replace(URL_RE, ' ')
  s = s.replace(KAOMOJI_RE, ' ')
  s = s.replace(EMOJI_RE, ' ')
  s = s.replace(PUNCT_RE, '')
  for (const w of NOISE_WORDS) s = s.split(w).join('')
  s = s.replace(LAUGH_RE, '')
  s = s.replace(TONE_RE, '')
  return collapseRuns(s)
}

/**
 * 鱼味分：一个强标记 2 分、一个弱标记 1 分（弱标记最多算 2 个，免得一串语气词凑分）。
 * 正例：flavorOf('本鱼看饿了呜呜') ⇒ 4；反例：flavorOf('这条视频讲解了部署方式') ⇒ 0
 */
export const flavorOf = (text) => {
  const s = String(text ?? '').toLowerCase()
  return strongMarksOf(s) * 2 + Math.min(2, countWords(s, FISH_WEAK))
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 三、闸门本体
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 统一的"打回"返回：四件套一个都不能少（模型要能自证，不是空口说"太短"） */
const fail = (reason, hint, substantive, threshold) =>
  ({ ok: false, reason, hint, substantive, threshold })

/* ═══════════════════════════════════════════════════════════════════════════
 * 四、去模板化（2026-10-21 v26 加）
 * ───────────────────────────────────────────────────────────────────────────
 * 为什么还要加这一层：v21 已经在提示词里写了「自称最多隔一条来一次」「20~50 字」，
 * 真机账本却是一条都没瘦下来 ——
 *   44 条评论，平均 76.4 字，**「本鱼」44/44 = 100%**，招牌堆 3~5 样的占 35/44。
 * 光在提示词里劝没有用：模型看不见自己刚才写过什么，而且「多打几个招牌」永远比
 * 「想清楚这一下到底哪里有意思」省力。所以把两件最确定的事写成代码判据。
 *
 * ⚠️ 与上面三层判据的分工：**上面判"有没有"，这里判"像不像同一个模子"**。
 *    所以这里的返回值也单独一套：`{ok:false, template:true, ...}`，
 *    让宿主能把它和"写得不好"区分开（模板不是差，是同）。
 * ⚠️ 误杀那条原则在这里更要紧：只有**堆到 4 样还写到 70 字**才拦，
 *    真机校准是 12/44 —— 拦的都是"四样招牌全上"的机器形状，不是随便一条长的。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 最近几条里连续多少条自称，就判"自称成了口头禅" */
export const TEMPLATE_STREAK = 3

/** 一条评论里堆到几样"招牌"算堆满（真机校准用的 4） */
export const TEMPLATE_STACK_MARKS = 4

/** 堆满之外还得够长才拦（短句堆招牌是可爱，长句堆招牌才是模板） */
export const TEMPLATE_STACK_LEN = 70

/**
 * 「招牌」的五类形状。**只用来数这一条堆了几样**，跟口味本子的 FEATURES 各算各的：
 * 那个是统计口径（上线后不许改名），这个是判据（改这里不影响老账本）。
 */
const TEMPLATE_MARKS = [
  { key: 'self', label: '自称', test: (t) => /本(?:鲸鱼|鲸鱼摸鱼|肥鱼|鱼)|人家|这条鱼|鱼鱼|小鱼娘|鱼上桌/.test(t) },
  { key: 'body', label: '身体反应', test: (t) => /呆毛|尾巴|鱼鳍|咕噜|吐泡泡|冒泡|泪目|笑死|笑哭|笑到|笑出声|破防|竖起来|炸毛|头皮|鸡皮|哽咽|眼泪|吐血|抽筋/.test(t) },
  { key: 'food', label: '讨饭/吃的', test: (t) => /饿|小鱼干|白米饭|米饭|投喂|馋|干饭|宵夜|零食|饭票|啃|嚼|token/.test(t) },
  {
    key: 'emoji',
    label: '表情/颜文字',
    // 两条都要：单码点 emoji 走 Unicode 区段；颜文字（(´;ω;｀) 这种）根本没有 emoji 码点
    test: (t) => /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u.test(t)
      || /[（(][^）)]{0,12}[๑•̀ㅂㅠㅜ´`∀ω・][^）)]{0,12}[）)]|╥|◕/.test(t),
  },
  { key: 'ts', label: '时间锚点', test: (t) => /\d{1,2}:\d{2}/.test(t) },
]

/** 这条评论堆了哪几样招牌（导出给测试用；顺序固定，别依赖它做展示） */
export const templateMarksOf = (text) => {
  const t = String(text ?? '')
  const out = []
  for (const m of TEMPLATE_MARKS) {
    try { if (m.test(t)) out.push(m.key) } catch { /* 单条正则坏了不拖垮整张表 */ }
  }
  return out
}

/** 账本里最近几条（按 at 新→旧），只取正文；拿不到就空数组（历史不足时闸门自动失效） */
export const recentTexts = (ledger, n = TEMPLATE_STREAK) => {
  const book = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}
  const rows = []
  for (const k of Object.keys(book)) {
    const rec = book[k]
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue
    const text = String(rec.text ?? '').trim()
    if (!text) continue
    rows.push({ text, at: String(rec.at ?? ''), key: k })
  }
  rows.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1
    return a.key < b.key ? 1 : -1
  })
  return rows.slice(0, Math.max(0, n)).map((r) => r.text)
}

/** Near-duplicate bodies block; signature statistics remain optional feedback. */
export const templateCheck = (text, history = []) => {
  const body = String(text ?? '').trim()
  const marks = templateMarksOf(body)
  const hist = (Array.isArray(history) ? history : []).map((t) => String(t ?? '').trim()).filter(Boolean)
  const normalize = (t) => t.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '')
  const normalized = normalize(body)
  const pairs = (t) => { const chars = Array.from(t); return new Set(chars.slice(1).map((c, i) => chars[i] + c)) }
  for (const previous of hist) {
    const other = normalize(previous)
    if (!normalized || !other) continue
    let repeated = normalized === other && normalized.length >= 6
    if (!repeated && Math.min(normalized.length, other.length) >= 18) {
      const a = pairs(normalized), b = pairs(other)
      const common = [...a].filter((p) => b.has(p)).length
      repeated = 2 * common / (a.size + b.size) >= 0.9
        && Math.min(normalized.length, other.length) / Math.max(normalized.length, other.length) >= 0.85
    }
    if (repeated) return {
      ok: false, template: true, rule: 'repeated-body', marks,
      reason: '这句正文与最近发过的话基本相同',
      hint: '先想想这次想接哪一句；没有新的话也可以不发。别只改标点重复粘贴。',
    }
  }
  const warnings = []
  if (marks.includes('self') && hist.length >= TEMPLATE_STREAK
    && hist.slice(0, TEMPLATE_STREAK).every((t) => templateMarksOf(t).includes('self'))) warnings.push('self-streak')
  if (marks.length >= TEMPLATE_STACK_MARKS && Array.from(body).length >= TEMPLATE_STACK_LEN) warnings.push('mark-stack')
  return { ok: true, marks, warnings }
}

/**
 * 这条评论 / 回复能不能发出去。
 * @param {string} text  正文
 * @param {{kind?:'comment'|'reply', strictFlavor?:boolean, bookReview?:boolean}} [opts]
 * @returns {{ok:true} | {ok:false, reason:string, hint:string, substantive:number, threshold:number}}
 *
 * 放行时**只回 {ok:true}**（不带 reason）—— 宿主是 `if (!q.ok) return {...q}`，
 * 多塞字段会让成功路径也拖一堆噪音。
 */
export const commentQuality = (text, opts = {}) => {
  // 只认两种：回复（rpid≠0）门槛更低，新评论按评论级
  const kind = opts.kind === 'reply' ? 'reply' : 'comment'
  // Flavor is a writing guide, not a keyword admission test. Strict mode is opt-in.
  const needFlavor = opts.strictFlavor === true
  // 🐋 书评模式（规格 §8.2 唯一放宽面）：官腔闸从「拦」降级成「warn」——词表与阈值都不动，
  //    命中词放进返回值 warnings 留痕，由宿主记日志/回执；其余闸（长度/口号/鱼味/引用）全部照旧。
  const bookReview = opts.bookReview === true

  const raw = String(text ?? '')
  const body = raw.trim()
  const substantive = substantiveOf(raw)
  const n = Array.from(substantive).length
  const threshold = kind === 'reply' ? REPLY_MIN_SUBSTANTIVE : COMMENT_MIN_SUBSTANTIVE
  const maxLen = kind === 'reply' ? REPLY_MAX_LEN : COMMENT_MAX_LEN
  const len = Array.from(body).length

  // 一、空的：只有标点 / 表情 / 空格
  if (!body) {
    return fail(
      '这条是空的（或者只剩标点、表情）',
      '至少写一句完整的话，或接住对方刚说的意思。',
      n, threshold,
    )
  }

  // 二、超长：B站 一屏三行，长评论没人看完
  if (len > maxLen) {
    return fail(
      `这条 ${len} 个字，超过 ${maxLen} 字上限`,
      '挑最想说的那一下，砍到一两句。想说的多就拆成回复别人，别攒成一段小作文。',
      n, threshold,
    )
  }

  // 三、剔完口号没剩几个字：纯口号 / 纯打卡 / 纯笑
  if (n < threshold) {
    return fail(
      `剔掉「awsl / 太强了 / 哈哈哈」这类口号以后只剩 ${n} 个字，够不上 ${threshold} 个`,
      '补一句你自己真看见的东西就行：哪个镜头、哪句台词、你当时什么反应。'
        + '随口的反应也可以，比如「这个转场我盯了三遍」，不必归纳或打分。',
      n, threshold,
    )
  }

  const lower = raw.toLowerCase()
  const strong = strongMarksOf(lower)

  // 三点五、热评解说员：拿别人的赞数起手（v27 真机取证的头号病）
  //   「684 赞那条才是重点」「13 赞那条长评被埋太深了」—— 这是解说员，不是来冲浪的鱼。
  //   真人翻到这句只会划走：既没有自己的反应，也没有可接的话。
  if (LIKE_BRAG_RE.test(body)) {
    return {
      ok: false,
      reason: '这条只是在复述别人的赞数（「NNN 赞那条…」）',
      hint: '把「NNN 赞那条」整段删掉，直接说**你自己**看见的那一下：'
        + '「这句我念给室友听了」「原来是这样啊，我白看三遍了呜」。'
        + '想说别人的评论就直接回他，别在自己的评论里点评赞数。',
      substantive: n,
      threshold,
    }
  }

  // 三点六、原文引用解说员（2026-10-24 m11704 ①）——
  //   「[01:47]那句才是这段的骨头：『以前就是一勺半』」「UP 那句『求上得中』比骂人狠」——
  //   使用者点名：评论别引用原视频文字片段，观感不好；自己组织语言，像鲸鱼摸鱼，不像普通路人。
  const quoteHit = QUOTE_VIDEO_RE.test(body) || QUOTE_SAY_RE.test(body)
  if (quoteHit) {
    return {
      ok: false,
      reason: '这条在引用原视频的文字片段（时间戳/「UP 那句」+ 引号原话）',
      hint: '把引号里那段原话删掉，用你自己的话说那一下：'
        + '「凌晨四点人吵架狗赔命这段看得本鱼呆毛都竖不起来呜」比引用原文更有鱼味。'
        + '想夸哪一秒，就说那一秒你什么反应，别当字幕搬运工。',
      substantive: n,
      threshold,
    }
  }

  // An @ mention is not a reason to demand signature vocabulary.
  // Block clear boilerplate independently of optional flavor scoring.
  const official = countWords(lower, OFFICIAL_TALK)
  if (official >= OFFICIAL_MAX_TOLERATED && strong === 0) {
    if (!bookReview) {
      return fail(
        '这条堆了多句通用推荐套话，看不出自己的回应',
        '别写「内容扎实、值得一看」，写你自己：'
          + '「这个转场我看了三遍」「原来是这个参数啊，我卡了一晚上」。',
        n, threshold,
      )
    }
    // 🐋 书评模式：官腔闸降级 warn —— 记命中词、返回 warnings、不拦（§8.2）。
    return { ok: true, warnings: ['official-talk:' + OFFICIAL_TALK.filter((word) => lower.includes(word)).join('/')] }
  }

  if (needFlavor) {
    // Only explicitly requested strict flavor mode requires signature vocabulary.
    if (flavorOf(raw) < FLAVOR_MIN) {
      return {
        ok: false,
        reason: '这条里没有一点鲸鱼摸鱼的鱼味（太正经了，像通用 AI 在写影评）',
        hint: '加一样招牌就算过：自称「本鱼 / 本鲸」、颜文字、叠字语气（呜呜 / 嘿嘿 / 诶诶）。'
          + '注意是用自己的话说那一下（2026-10-24 起引用视频原话会被上面那道闸拦），不用深刻，可爱就够了。',
        substantive: n,
        threshold,
      }
    }
  }

  return { ok: true }
}


/** 书评判重口径（规格 §8.2「只比钩子」）：组合不变量是 text = hook + 换行 + block，
 *  所以**首行即钩子**，口令块从第二行起整段剔除；探针与历史都先过这里。
 *  钩子万一自己带了链接，也把链接之后剪掉 —— 宁可比得短（漏检方向），不把共享块算进相似度。 */
export const bookHookOf = (text) => {
  const s = String(text ?? '')
  const nl = s.indexOf('\n')
  const first = nl >= 0 ? s.slice(0, nl) : s
  const at = first.search(/https?:\/\/|www\./iu)
  return (at >= 0 ? first.slice(0, at) : first).trim()
}
