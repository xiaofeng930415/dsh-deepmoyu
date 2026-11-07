/**
 * lib/dup.mjs —— 「这一条是不是已经回过了」的**统一**判据（纯函数，不碰网络/磁盘）
 * ============================================================================
 * 为什么要有它（2026-10-21，使用者要求「回复过的评论不要重复回复」）：
 *   判重以前是**四条链路各写一遍**，钥匙各用各的：
 *     · 视频评论回复   → `replyRpid`
 *     · 动态（opus）   → `opus:<root||rpid>`
 *     · 私信           → `msgSeqno`
 *     · 新评论         → 没有判重（本来就不该重复发同一句）
 *   各写一遍的下场是：中间那条（动态）漏了一次，两处键名一变就静默失效，
 *   而且"回过了"的判断散在四个地方，谁都不知道对方记的是什么。
 *
 *   这里只做一件事：**把"回复目标"归一成一把钥匙**。所有写账/查账都过这里，
 *   以后加第二条链路也不会再跑偏。
 *
 * 不变量（改之前先读）：
 *   · 返回值空串 = 没回过（可以回）；非空 = 给模型看的一句人话，说清为什么不用回。
 *   · 钥匙**必须带前缀** —— `opus:` / `dm:` / `video:` / `nu:`（新评论按正文去重也用同一个面）。
 *     不带前缀的话 12345 这个 rpid 和 12345 这个动态楼层会撞在一起。
 *   · 老账本（`repliedComments` 里没前缀的裸 rpid / `dmReplied` 的裸 seqno）**照样认**：
 *     老数据不能因为换了钥匙格式就失效（那就是"回过的又要再回一遍"）。
 */

import { normalizeId, optionalId, readableId } from './ids.mjs'

/** 账本里最多记多少条（四种键混在一个面里，给宽一点） */
export const DUP_LEDGER_MAX = 2000

/** 视频评论回复：对方那条评论的 rpid（`root` 只是排版用，不是钥匙） */
export const keyVideoReply = (replyRpid) => {
  const id = readableId(replyRpid, { allowZero: false })
  return id ? `video:${id}` : ''
}

/**
 * 动态（opus）回复：同一层楼只回一次。
 *
 * ⚠️ 这里有过一次**真事故**（2026-10-20）：动态的 rpid 只在**一条动态内部**唯一，
 * 两条不同动态下可能出现同一个 rpid。早先用 `opus:<root||rpid>` 当钥匙，
 * 结果 A 动态下回过的楼，B 动态下同号的那层被误判成「回过了」——静默漏回。
 * 所以钥匙必须带上 `opusId` 才能区分是「哪条动态下的哪层」。
 *
 * 现在的钥匙：`opus-reply:<opusId>:<rpid>`
 *   · `rpid` 是必须的 —— 没有它就不知道该回哪一层（`root` 只是排版用，不是身份）
 *   · `opusId` 是必须的 —— 没有它就分不清动态
 *   · 两者缺一个 ⇒ 空串（= 没法判重，让它走「不知道回没回过」而不是「一定回过」）
 *
 * 老账本兼容：`opus:<root||rpid>` 是旧格式，**只读**。
 * 调用方查账时把它作为 `legacyKeys` 传进 `dupLookup`（`index.js` 已经这么做了），
 * 新写入的一律是新格式 —— 这样老数据不失效，新数据不再撞号。
 */
export const keyOpusReply = (rpid, root, opusId) => {
  const layer = readableId(rpid, { allowZero: false })
  const dyn = readableId(opusId, { allowZero: false })
  // root is layout, never the identity of the selected reply target.
  return layer && dyn ? `opus-reply:${dyn}:${layer}` : ''
}

/** Old unscoped keys are read-only aliases, never newly written identities. */
export const legacyOpusKeys = (rpid, root) => {
  try {
    const target = normalizeId(rpid, { allowZero: false })
    const floor = optionalId(root)
    return [...new Set([`opus-reply:${target}`, `opus:${floor !== '0' ? floor : target}`, `opus:${target}`])]
  } catch { return [] }
}

/** A sequence number is scoped to its recipient; no unscoped key is newly written. */
export const keyDmReply = (msgSeqno, uid) => {
  const seq = readableId(msgSeqno, { allowZero: false })
  const receiver = readableId(uid, { allowZero: false })
  return seq && receiver ? `dm:${receiver}:${seq}` : ''
}

/** Read-only compatibility with the former dm:<seq> and bare-sequence ledgers. */
export const legacyDmKeys = (msgSeqno) => {
  const seq = readableId(msgSeqno, { allowZero: false })
  return seq ? [`dm:${seq}`, seq] : []
}

/** 发新评论：同一个视频只发一条（视频维度，不看正文 —— 正文换一句也还是同一条视频） */
export const keyNewComment = (bvid) => {
  const s = String(bvid ?? '').trim()
  return /^BV[0-9A-Za-z]{10}$/.test(s) ? `nu:${s}` : ''
}

/**
 * 查账：这条回过了没有。
 * @param {Record<string,{at?:string,bvid?:string,rpid?:number}>} ledger  state.json 的 `repliedComments`
 * @param {string} key  上面四个 key*() 之一
 * @param {string[]} [legacyKeys] 老格式的裸钥匙（比如没前缀的 rpid / seqno），照样认
 * @returns {{hit:boolean, at:string, key:string}}  `hit=true` 表示回过了
 */
export const dupLookup = (ledger, key, legacyKeys = []) => {
  const book = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}
  if (!key) return { hit: false, at: '', key: '' }
  const parts = String(key).split(':')
  for (const k of [key, ...legacyKeys].map((x) => String(x ?? '')).filter(Boolean)) {
    const rec = book[k]
    if (!rec) continue
    if (k !== key && parts.length === 3) {
      // Known metadata can prove an old unscoped entry belongs to another target.
      // Missing/old metadata remains a conservative duplicate, never an automatic resend.
      if (parts[0] === 'opus-reply') {
        const opus = readableId(rec.opus_id, { allowZero: false })
        const rpid = readableId(rec.rpid, { allowZero: false })
        if ((opus && opus !== parts[1]) || (rpid && rpid !== parts[2])) continue
      }
      if (parts[0] === 'dm') {
        const uid = readableId(rec.uid, { allowZero: false })
        const seq = readableId(rec.msg_seqno ?? rec.seqno, { allowZero: false })
        if ((uid && uid !== parts[1]) || (seq && seq !== parts[2])) continue
      }
    }
    return { hit: true, at: String(rec.at || ''), key: k }
  }
  return { hit: false, at: '', key: '' }
}

/** 账本归一：不是对象就当空账本（判重函数共用的入口，避免每个都写一遍三目） */
const dupBook = (ledger) =>
  ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}

const dupMiss = { hit: false, at: '', key: '' }

/**
 * 跨通道判重（2026-10-25 修「回一个人一条评论两条消息」）
 * ============================================================================
 * 真机事故：**同一条评论**能从两条路回，两个键各记各的，谁也不认谁 ——
 *   · `bili_reply(bvid, rpid)`         → 记 `video:<rpid>`
 *   · `bili_reply_opus(opus_id, rpid)` → 记 `opus-reply:<opusId>:<rpid>`
 * 模型先在视频通道回一次、稍后又在动态通道看到同一条（`bili_opus_comments` 那边
 * 因为查的是 opus 键、自然是"没回过"）就再回一次 ⇒ 同一个人同一条评论收到两条。
 * 账本里实测有 34 个 rpid 这样重复过，最近一例相隔 4 分 24 秒（rpid 318036124737）。
 *
 * 修法：**判重按 rpid 认，不按"哪条通道记的"认**。同一条评论只回一次，
 * 不管这一次走的是哪个工具。
 *
 * 边界（别再走回 2026-10-20 那个坑）：
 *   · 视频通道 → 认**任意**动态键里的同号 rpid（视频评论没有"哪条动态"这层，必须认）
 *   · 动态通道 → 只额外认**视频通道**的 `video:<rpid>` / 裸 rpid；
 *     **不**去认别的动态的 `opus-reply:<别的opus>:<rpid>`
 *     （动态楼层在别处同号是可能的，认了就会静默漏回 —— 那是当初加 opusId 的原因）
 *   · 取向仍是"宁可不回，不要重复回"：判重失效的下场是对同一个人刷屏，
 *     比漏回一条恶劣得多（见 lib/reply.mjs 顶部那段）
 */

/** 视频通道（`bili_reply` / received_replies / my_video_comments）的判重 */
export const dupLookupVideoComment = (ledger, replyRpid) => {
  const book = dupBook(ledger)
  const id = readableId(replyRpid, { allowZero: false })
  if (!id) return dupMiss
  const fast = dupLookup(book, keyVideoReply(id), [id])
  if (fast.hit) return fast
  // 🔁 动态通道记过同一个 rpid ⇒ 这条评论已经回过了
  const suffix = `:${id}`
  for (const [k, rec] of Object.entries(book)) {
    if (k.startsWith('opus-reply:') && k.endsWith(suffix)) {
      return { hit: true, at: String(rec?.at || ''), key: k }
    }
  }
  return dupMiss
}

/** 动态通道（`bili_reply_opus` / opus_comments）的判重 */
export const dupLookupOpusComment = (ledger, rpid, root, opusId) => {
  const book = dupBook(ledger)
  const id = readableId(rpid, { allowZero: false })
  if (!id) return dupMiss
  const floor = optionalId(root)
  const legacy = floor !== '0' ? floor : id
  const fast = dupLookup(book, keyOpusReply(id, root, opusId), [...legacyOpusKeys(id, root), legacy])
  if (fast.hit) return fast
  // 记录里没写 opus_id 的老楼层键（`opus:<root>`）：有 rpid 对上就认，
  // 没写 rpid 的旧记录按保守算「回过了」（见 dupLookup 里那段注释）
  if (floor !== '0') {
    const byRoot = dupLookup(book, keyOpusReply(id, root, opusId), [floor])
    if (byRoot.hit) return byRoot
  }
  // 🔁 视频通道记过同一个 rpid ⇒ 这条评论已经回过了（别再回第二遍）
  return dupLookup(book, keyVideoReply(id), [id])
}

/**
 * 给模型看的拒绝话术（统一口径 —— 四处都是这一句，它一眼就知道该换谁回）。
 * @param {string} what  '这条评论' / '这条动态的这层' / '这条私信'
 * @param {string} at    回过的那个时间（可能空）
 */
export const dupHint = (what, at) =>
  `${what}已经回过了${at ? `（${at}）` : ''} —— 不用再回一遍。` +
  '想换个人回就翻 `bili_received_replies` / `bili_dm_inbox` 里 `can_reply=true` 的。'

/**
 * 记一笔。返回**新对象**（不改入参）。
 * @param {Record<string,object>} ledger
 * @param {string} key
 * @param {object} rec
 */
export const dupRemember = (ledger, key, rec) => {
  const next = { ...(ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}) }
  const k = String(key ?? '').trim()
  if (!k) return next
  next[k] = rec
  const keys = Object.keys(next)
  if (keys.length > DUP_LEDGER_MAX) {
    // 按记录时间砍最早的（rpid 是单调的，但不是所有账本都带 at ⇒ 没 at 的排最后，优先生效）
    keys
      .sort((a, b) => String(next[a]?.at || '9999').localeCompare(String(next[b]?.at || '9999')))
      .slice(0, keys.length - DUP_LEDGER_MAX)
      .forEach((x) => delete next[x])
  }
  return next
}

/** 老账本迁移：把 `repliedComments` 里没前缀的裸 rpid 补成 `video:<rpid>`（幂等） */
export const dupMigrate = (ledger) => {
  const book = ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {}
  let changed = 0
  const next = {}
  for (const [k, v] of Object.entries(book)) {
    if (/^(video|opus|dm|nu):/.test(k)) { next[k] = v; continue }
    // 裸数字：老版本只给视频回复用过这个格式 ⇒ 补成 video:
    if (/^\d+$/.test(k)) { next[`video:${k}`] = v; changed++; continue }
    next[k] = v
  }
  return { ledger: next, changed }
}


/* ═══════════════════════════════════════════════════════════════════════════
 * 鲸鱼书评线（规格 docs/spec-whale-bili-book-comment.md §8.3）——同书 / 同 UP 每日 ≤1。
 * 与 nu:<BV> 同一面（repliedComments）、同一把锁（withStateLock）、同一套淘汰
 * （dupRemember 按 at 砍最早）。钥匙只在**发送成功后**写（不预占，§8.3）。
 * ═══════════════════════════════════════════════════════════════════════════ */

/** 书评：同一本书每天最多一条。钥匙是书源门回传的 bookId（slug 或台账名，宿主不解释内容）。 */
export const keyBook = (bookId) => {
  const s = String(bookId ?? '').trim()
  return s && !/[\r\n\t]/.test(s) && s.length <= 120 ? 'book:' + s : ''
}

/** 书评：同一个 UP 主每天最多一条。钥匙是 UP 的 mid（十进制字符串，跟全仓 ID 口径一致）。 */
export const keyUp = (uid) => {
  const id = readableId(uid, { allowZero: false })
  return id ? 'up:' + id : ''
}

const localDayKey = (value) => {
  const d = value instanceof Date ? value : new Date(String(value ?? ''))
  return d && Number.isFinite(d.getTime()) ? d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() : ''
}

/**
 * 「每日 ≤1」的当日口径：命中且 at 落在**同一个本地日**才算当日重复。
 * 老记录没有 at（或解析不了）按保守口径算当日 —— 宁可少发，不可对同一本书/同一个 UP 重复刷。
 */
export const dupHitToday = (at, now = new Date()) => {
  const key = localDayKey(at)
  return !key || key === localDayKey(now)
}
