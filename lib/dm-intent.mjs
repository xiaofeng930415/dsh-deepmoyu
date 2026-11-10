/**
 * lib/dm-intent.mjs —— 私信「是不是在要资源 + 书名是什么」（纯函数：不碰网络、不碰磁盘）
 * ============================================================================
 * 规格 #1751（鲸鱼私信线）B 段：判定链是「规则先筛 → 模型确认并抽名 → 书源门兜底」。
 * 本文件只负责**规则那一半**：给一段私信正文 + 最近会话上下文，回答两个问题 ——
 *   ① 这条像不像在要资源（`seeking`）
 *   ② 如果像，书名候选是什么（`titles`）；抽不出唯一一个 ⇒ `needAsk`（追问）
 * 剩下的（拿候选书名调书源门、组口令块、真发）是宿主的活，不在这里。
 *
 * 为什么规则要先跑一遍（规格 B 段原话「规则先筛，不花模型」）：
 *   私信值守是 3–5 分钟一跳的长跑，绝大多数消息是闲聊（"在吗""谢谢你""晚安"）。
 *   每条都过模型 = 白烧 token + 把账号的动作面撑大；先用规则把闲聊筛掉，
 *   只有"疑似求资源"的才值得起一轮模型去确认与抽名。
 *
 * 不变量（改之前先读）：
 *   · **纯函数**：零 IO（不读文件、不联网、不取时钟）。测试拿固定语料钉住，不等真机。
 *   · 返回**结构化**结果，不给"人话理由" —— 人话由宿主按结果拼（模型看得懂字段）。
 *   · `needAsk=true` 时**绝不猜书名**：宁可追问一句，也不能拿一本错书去调书源门
 *     （发了错资源 = 一次不可逆的翻车，书源门侧 claim 不可逆，§6.6）。
 *   · 关键词表**只增不减**；删一个词要让一条本来能筛中的私信掉进闲聊 —— 静默劣化。
 */

/**
 * 求资源关键词（规则先筛的第一道）。
 * ⚠️ 每条都是**实测/推理出来的高频问法**，不是拍脑袋：
 *   「有…吗 / 有没有 / 求 / 发我 / 分享 / 资源 / 下载 / pdf / 资料 / 书 / 章节 / 版」
 *   太宽的词（"给我"）不放进来：会把"给我看看你家的猫"也筛成求资源。
 * ⚠️ 「有…吗」这种中间夹书名的问法**不能**靠一个「有吗」子串命中 —— 所以除关键词外，
 *   `looksResourceSeeking` 还认「书名号包裹」这一形态（见函数体）。
 */
export const RESOURCE_KEYWORDS = Object.freeze([
  '有没有', '有么', '有没', '有嗎', '有吗', '有啊', '有么',
  '求', '发我', '给我发', '分享一下', '分享', '求分享', '求资源', '资源',
  '下载', 'pdf', 'PDF', 'epub', 'mobi', 'txt', '电子版', '电子书', '文档',
  '资料', '书籍', '书本', '全书', '合集', '版本', '译本',
  '能发', '发一下', '发个', '发条', '求书', '求pdf', '求个', '想要', '找一本', '找书', '找资源',
])

/** 「书名号包裹」本身就是求资源强信号（B站私信里几乎只出现在要书/推荐书两种场景） */
const BOOK_QUOTED_RE = /[《「『][^《》「」『』]{1,60}[》」』]/

/** 书名常见的包裹符号：中文书名号、直角引号、引号。剥掉后剩下的就是候选书名。 */
const BOOK_MARK_RE = /[《》〈〉「」『』“”"'‘’]/g

/** 单条正文最多抽几个书名候选（多了交给模型挑，规则不猜） */
const MAX_TITLE_CANDIDATES = 5

/** 上下文最多回看几条（补「你推的那本」这类指代；多了只是噪声） */
export const MAX_CONTEXT_ROWS = 12

const clean = (v) => String(v ?? '').trim()

/** 书名候选归一化：剥掉书名号/引号/首尾空白，去掉纯符号与过短的碎片。 */
const normalizeTitle = (raw) => {
  const t = clean(raw).replace(BOOK_MARK_RE, '').replace(/[\s]+/g, ' ').trim()
  if (!t) return ''
  // 太短的（1–2 字）多半是"那本""这书"这类指代，不是书名 —— 交给模型从上下文补
  if (Array.from(t).length < 3) return ''
  return t
}

/**
 * 规则筛：这条像不像在要资源。
 * 两个信号，命中其一即算（规则层宁可多放行，漏放行的代价是把要资源的人当闲聊晾着）：
 *   ① 关键词（`RESOURCE_KEYWORDS`）
 *   ② 书名号包裹的书名（「有《XX》吗」这种问法里，「有…吗」被书名劈开了，子串命中不到）
 * @param {string} text 私信正文
 * @returns {boolean}
 */
export const looksResourceSeeking = (text) => {
  const body = clean(text)
  if (!body) return false
  if (BOOK_QUOTED_RE.test(body)) return true
  return RESOURCE_KEYWORDS.some((kw) => body.includes(kw))
}

/**
 * 书名候选抽取：书名号 > 引号 > 「关键词 + 名词」的宽松形态。
 * 抽不出 ⇒ 空数组（宿主据此 `needAsk`，不猜）。
 *
 * @param {string} text 私信正文
 * @param {string[]} [context] 最近上下文（早 → 晚；用于指代补全，规则只做最保守的补）
 * @returns {string[]} 候选书名（已归一化、去重；可能为空）
 */
export const extractTitleCandidates = (text, context = []) => {
  const body = clean(text)
  if (!body) return []
  const out = []

  /* ① 书名号/引号包裹的（最可靠，直接收）。
   *    正则捕获组里可能带空白/标点，交给 normalizeTitle 收干净。 */
  const quoted = body.match(/[《「『“"‘’][^《》「」『』“”"'‘’]{1,60}[》」』”"’]/g) || []
  for (const q of quoted) {
    const t = normalizeTitle(q)
    if (t) out.push(t)
  }

  /* ② 「求 / 发我 / 有没有」这类关键词后面的名词短语（宽松，最多 40 字）。
   *    只在①没抽到时跑 —— 书名号是明确信号，宽松形态是兜底。
   *    关键词 + 紧跟的量词/副词（一下/个/本/份/部/套/条）先整段吃掉，剩下的当候选书名；
   *    句末的语气词（吗/呢/啊/谢谢）也切掉，免得"小岛经济学吗"进书源门查不到。 */
  if (!out.length) {
    const KW = '(?:求|发我|给我发|分享一下|分享|下载|找|想要|有没有|有)'
    const LEAD = KW + '[了的本个部全套条下一并]*'
    const loose = body.match(new RegExp(LEAD + '\\s*([\\u4e00-\\u9fa5A-Za-z0-9：·．.、－\\-_]{2,40})', 'g')) || []
    for (const l of loose) {
      const t = normalizeTitle(l.replace(new RegExp('^' + LEAD), '').replace(/[吗呢啊呀吧嘛~。！？!?，,、\s]+$/g, ''))
      if (t) out.push(t)
    }
  }

  /* ③ 上下文里的书名号（补「你推的那本」—— 最近一条被书名号包起来的，优先级最高）。 */
  if (!out.length && Array.isArray(context) && context.length) {
    for (let i = context.length - 1; i >= 0 && out.length < MAX_TITLE_CANDIDATES; i--) {
      const row = clean(context[i])
      if (!row) continue
      const quoted = row.match(/[《「『“"‘’][^《》「」『』“”"'‘’]{1,60}[》」』”"’]/g) || []
      for (const q of quoted) {
        const t = normalizeTitle(q)
        if (t && !out.includes(t)) out.push(t)
      }
    }
  }

  // 去重 + 限量 + 保序（后面的同名候选不重复出现）
  const seen = new Set()
  return out.filter((t) => (seen.has(t) ? false : (seen.add(t), true))).slice(0, MAX_TITLE_CANDIDATES)
}

/**
 * 完整判定（规则那一半的对外唯一入口）。
 *
 * @param {string} text 私信正文
 * @param {string[]} [context] 最近上下文（早 → 晚；宿主从 bili_dm_thread 拿，注意**新→旧**，要反转）
 * @returns {{seeking: boolean, titles: string[], needAsk: boolean, reason: string}}
 *   seeking  这条像不像在要资源（规则层判断；模型可推翻，但规则说不像的默认不进书源门）
 *   titles   候选书名（可能为空）
 *   needAsk  抽不出唯一书名 ⇒ 追问（**不要猜**）
 *   reason   一句话说明为什么是这个结果（给人/日志看，不进链路）
 */
export const dmResourceIntent = (text, context = []) => {
  const body = clean(text)
  if (!body) {
    return { seeking: false, titles: [], needAsk: false, reason: '空消息（非文本消息或不支持的类型）' }
  }
  if (!looksResourceSeeking(body)) {
    return { seeking: false, titles: [], needAsk: false, reason: '规则未命中求资源关键词（按闲聊处理）' }
  }
  const titles = extractTitleCandidates(body, context)
  if (!titles.length) {
    return {
      seeking: true, titles: [], needAsk: true,
      reason: '像在要资源但抽不出书名（可能是指代，读上下文补或追问）',
    }
  }
  if (titles.length > 1) {
    return {
      seeking: true, titles, needAsk: true,
      reason: '抽出多个候选书名（' + titles.join(' / ') + '）—— 需要确认是哪一本，别猜',
    }
  }
  return { seeking: true, titles, needAsk: false, reason: '唯一候选书名：' + titles[0] }
}
