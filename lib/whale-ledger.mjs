/**
 * lib/whale-ledger.mjs —— 鲸鱼书评线本地 ledger（规格 docs/spec-whale-bili-book-comment.md §10.1）
 * ============================================================================
 * 书评线的**唯一业务权威**：一条记录 = 一次书评生命周期，三个写入点逐段补全：
 *   WP1 书源门命中（gate → block 注入后立刻写）：book_id / book_title / link / code /
 *       disk / from_ledger / job_id / candidate_id —— 链接与提取码从**口令块文本**解析
 *       （块本身就是要发出去的链接，宿主拼接过 ⇒ 不需要额外服务器调用，模型依旧看不见块）；
 *   WP2 发前：hook / block / order_kind(quark|baidu) / like_line / 字数；
 *   WP3 发后：rpid（十进制字符串）/ guard_status / posted_at / posted_ts。
 * 失败与跳过走 events[]（gate-miss / hook-over-budget / dup-book / …；§10.1 事件码为基础集，
 *   可追加）。对账自愈（§10.1）：guard 只读快照的 send 行与本 ledger 求差集 ⇒ 补记。
 *
 * 落点偏差说明：规格字面路径是主仓 .context/whale-book-comment/ledger.json，但批运行的
 *   cwd 是插件家（DUTY home），运行时不可达主仓路径 ⇒ 落 stateDir/whale-book-comment/ledger.json
 *   （与旧线 .context/bili-promotion/ledger.json 天然隔离，两账号不共 JSON 的不变量不变）。
 *   仓内镜像与服务器上报（push 侧）从 DUTY 家读取。
 *
 * 本文件纯函数为主（不碰网络；文件 IO 只留原子写助手），全部可离线单测。
 */
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readJson, writeJson, dayKey } from './state.mjs'

export const WHALE_LEDGER_DIR = 'whale-book-comment'

/** posted / events 的封顶：书评线 3–5 条/天，2000 ≈ 一年多的量，防失控（照 dup.mjs 口径） */
export const WHALE_LEDGER_MAX = 2000

export const whaleLedgerFile = (stateDir) => join(stateDir, WHALE_LEDGER_DIR, 'ledger.json')

export const emptyLedger = () => ({ version: 1, posted: [], events: [], stop: null, recovery: null, speed: null, fail_streak: 0, unknown_streak: 0 })

/** 原子落盘（写侧自带损坏拒写；目录首次创建）。调用方负责拿 withStateLock 串行化。 */
export const writeWhaleLedgerFile = (stateDir, ledger) => {
  mkdirSync(join(stateDir, WHALE_LEDGER_DIR), { recursive: true })
  writeJson(whaleLedgerFile(stateDir), ledger)
}

/* ── 口令块 → link / code / disk（WP1 的链接来源）── */
const URL_RE_BLOCK = /https?:\/\/\S+/

/** 块文本里的第一个 URL + 「提取码：」行；盘别按域名判。规格 §6.7：插件不懂块格式，只做拼接与计字——
 *  这里也只做「找 URL 行 / 找提取码行」两级查找，不校验块的行数与字数（那是 tools/book-gate 的职责）。 */
export const parseBlockContact = (block) => {
  const s = String(block ?? '')
  const url = (s.match(URL_RE_BLOCK) || [''])[0]
  const codeLine = s.split('\n').find((l) => /^提取码[:：]/.test(l.trim()))
  const code = codeLine ? codeLine.replace(/^提取码[:：]\s*/, '').trim() : ''
  // 盘别跟**找到的那个 URL** 的域名走（块同时含两域名时 disk 与 link 不打架）
  const disk = /pan\.baidu\.com/.test(url) ? 'baidu' : /pan\.quark\.cn/.test(url) ? 'quark' : ''
  return { url, code, disk }
}

/* ── 求赞行（WP2 的 like_line 列）：钩子里单独一行「求个赞/求三连」之类的尾巴 ── */
const LIKE_LINE_RE = /求[^，。！!？?\n]{0,8}(赞|三连|关注)/
export const likeLineOf = (hook) => {
  const lines = String(hook ?? '').split('\n')
  return lines.reverse().find((l) => LIKE_LINE_RE.test(l))?.trim() || ''
}

/** 本地日键（复用 state.mjs 的 dayKey，补零格式统一）；非法输入给空串。 */
export const localDayOf = (value) => {
  const d = value instanceof Date ? value : new Date(String(value ?? ''))
  return Number.isFinite(d?.getTime()) ? dayKey(d) : ''
}

const nowIso = () => new Date().toISOString()

/** 封顶：按各自行内的时间戳砍最老（at 缺失排最后，优先存活）。返回原对象（调用方持锁内使用）。 */
export const capLedger = (ledger) => {
  const evict = (rows, tsOf) => {
    if (rows.length <= WHALE_LEDGER_MAX) return rows
    return [...rows].sort((a, b) => String(tsOf(a) || '9999').localeCompare(String(tsOf(b) || '9999'))).slice(rows.length - WHALE_LEDGER_MAX)
  }
  return { ...ledger, posted: evict(ledger.posted, (r) => r.gate_hit_ts || r.posted_ts), events: evict(ledger.events, (r) => r.ts) }
}

/** 共享守卫：不是对象/数组形状就当空账本（与 readJson 的容错口径一致）。 */
const baseOf = (ledger, key) => ledger && typeof ledger === 'object' && !Array.isArray(ledger) && Array.isArray(ledger[key]) ? ledger : emptyLedger()

/** 已发出的行（sent=true 且有 posted_ts）——运行边界（§9.2/§9.5）的统计口径。 */
export const sentRowsOf = (ledger) => {
  const base = baseOf(ledger, 'posted')
  return base.posted.filter((row) => row && row.sent === true && Number(row.posted_ts) > 0)
}
/** 行内更新：找不到 id 原样返回（WP1 一定先于 WP2/WP3 发生）。 */
const updatePostedAt = (base, id, entry) => {
  const i = base.posted.findIndex((r) => r.id === String(id ?? ''))
  if (i < 0) return base
  const posted = [...base.posted]
  posted[i] = { ...posted[i], ...entry }
  return capLedger({ ...base, posted })
}

/** §10.2：aid/mid ← x/web-interface/view（组合阶段 uid 预检已在手，入库不用二次请求）。 */
const positiveIntOrNull = (value) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
const statNumOrNull = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
/** 发送时点顺手的视频统计（bili_video_info.stat + pubdate）：发时进 videoSnapshots(source='entry') 用 */
const entryStatOf = (stat) => stat && typeof stat === 'object' && !Array.isArray(stat)
  ? {
      view: statNumOrNull(stat.view),
      reply: statNumOrNull(stat.reply),
      like: statNumOrNull(stat.like),
      danmaku: statNumOrNull(stat.danmaku),
      pubdate_ts: statNumOrNull(stat.pubdate_ts),
    }
  : null

/** WP1 书源门命中。幂等：同 id 只更新 gate 字段（批准重放/重试不重复建行）。 */
export const withGateHit = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  const contact = parseBlockContact(rec?.block)
  const at = nowIso()
  const entry = {
    id: String(rec?.id ?? ''),
    bvid: String(rec?.bvid ?? ''),
    book_id: String(rec?.bookId ?? ''),
    book_title: String(rec?.bookTitle ?? ''),
    link: contact.url,
    code: contact.code,
    disk: contact.disk,
    from_ledger: rec?.fromLedger === true,
    job_id: rec?.jobId ?? null,
    candidate_id: rec?.candidateId ?? null,
    ledger_lookup: String(rec?.ledgerLookup ?? ''),
    aid: positiveIntOrNull(rec?.aid),
    mid: positiveIntOrNull(rec?.mid),
    entry_stat: entryStatOf(rec?.entryStat),
    gate_hit_at: at,
    gate_hit_ts: Date.parse(at) || 0,
  }
  if (!entry.id) return capLedger(base)
  const i = base.posted.findIndex((r) => r.id === entry.id)
  const posted = [...base.posted]
  if (i >= 0) posted[i] = { ...posted[i], ...entry }
  else posted.push(entry)
  return capLedger({ ...base, posted })
}

/** WP2 发前：hook / block / order_kind / like_line / 字数。记录不存在时忽略（WP1 一定先发生）。 */
export const withBeforeSend = (ledger, id, rec) => {
  const base = baseOf(ledger, 'posted')
  const block = String(rec?.block ?? '')
  const entry = {
    hook: String(rec?.hook ?? ''),
    block,
    order_kind: parseBlockContact(block).disk,
    like_line: likeLineOf(rec?.hook),
    char_count: Number(rec?.charCount) || 0,
    before_send_at: nowIso(),
  }
  return updatePostedAt(base, id, entry)
}

/** WP3 发后：rpid（十进制字符串，原样保留）/ guard_status / posted_at / posted_ts。 */
export const withAfterSend = (ledger, id, rec) => {
  const base = baseOf(ledger, 'posted')
  const postedAt = rec?.postedAt || (rec?.sent === true ? nowIso() : '')
  const entry = {
    rpid: String(rec?.rpid ?? ''),
    guard_status: String(rec?.guardStatus ?? ''),
    sent: rec?.sent === true,
    error_code: rec?.errorCode ?? null,
    posted_at: postedAt,
    posted_ts: postedAt ? (Date.parse(postedAt) || 0) : 0,
  }
  return updatePostedAt(base, id, entry)
}

/* ── V1 核验槽位（§10.3）与入库回执（§10.2）── */
export const V1_SLOTS = ['v1_30min', 'v1_24h']
export const V1_DELAYS_MS = { v1_30min: 30 * 60_000, v1_24h: 24 * 3600_000 }
const V1_STATUS = ['hit', 'invisible', 'miss']
const INGEST_MAX_ATTEMPTS = 5

/** V1 结果（§10.3：只写本地 ledger，不写服务端 visibility）。slot 必须是已知槽位；未知 id 忽略。 */
export const withV1Result = (ledger, id, slot, rec) => {
  if (!V1_SLOTS.includes(slot)) return baseOf(ledger, 'posted')
  const at = String(rec?.at ?? '') || nowIso()
  const entry = {
    at,
    ts: Date.parse(at) || 0,
    status: V1_STATUS.includes(rec?.status) ? rec.status : 'miss',
    likes: Number.isSafeInteger(rec?.likes) ? rec.likes : null,
    floor: Number.isSafeInteger(rec?.floor) ? rec.floor : null,
    rcount: Number.isSafeInteger(rec?.rcount) ? rec.rcount : null,
    probe_code: rec?.probe_code != null ? String(rec.probe_code).slice(0, 12) : null,
    how: String(rec?.how ?? '').slice(0, 80),
    note: String(rec?.note ?? '').slice(0, 160),
  }
  return updatePostedAt(baseOf(ledger, 'posted'), id, { [slot]: entry })
}

/** 入库回执（§10.2）。成功落 ingest_at（不再重推，服务端幂等兜底）；失败 attempts+1，
 *  达 INGEST_MAX_ATTEMPTS 或调用方显式 givenUp 时封口（ingest_given_up，select 不再选中）。 */
export const withIngest = (ledger, id, rec) => {
  const base = baseOf(ledger, 'posted')
  const i = base.posted.findIndex((r) => r.id === String(id ?? ''))
  if (i < 0) return base
  // 终态守卫：已确认入库 / 已封口的行不再改写（迟到的失败回执不覆盖成功，封口后不再计数）
  if (base.posted[i].ingest_ok === true || base.posted[i].ingest_given_up === true) return base
  if (rec?.ok === true) {
    return updatePostedAt(base, id, {
      ingest_at: nowIso(),
      ingest_ts: Date.now(),
      ingest_ok: true,
      ingest_error: null,
      ingest_counts: rec?.counts && typeof rec.counts === 'object' ? rec.counts : null,
    })
  }
  const attempts = Number(base.posted[i].ingest_attempts ?? 0) + 1
  const givenUp = rec?.givenUp === true || attempts >= INGEST_MAX_ATTEMPTS
  const entry = {
    ingest_ok: false,
    ingest_error: String(rec?.error ?? 'unknown').slice(0, 120),
    ingest_attempts: attempts,
  }
  if (givenUp) {
    entry.ingest_given_up = true
    entry.ingest_at = nowIso()
    entry.ingest_ts = Date.now()
  }
  return updatePostedAt(base, id, entry)
}

/** 到期的 V1 槽位：sent 且有 rpid 的行，30min/24h 各一次；一行一轮只出一个槽（先到期先查）。 */
export const dueV1Checks = (ledger, nowTs = Date.now(), { max = 4 } = {}) => {
  const base = baseOf(ledger, 'posted')
  const now = Number(nowTs) || Date.now()
  const due = []
  for (const row of base.posted) {
    if (row.sent !== true || !String(row.rpid ?? '').trim()) continue
    if (!Number.isSafeInteger(row.posted_ts) || row.posted_ts <= 0) continue
    for (const slot of V1_SLOTS) {
      if (row[slot]) continue
      if (now >= row.posted_ts + V1_DELAYS_MS[slot]) {
        due.push({ row, slot })
        break
      }
    }
    if (due.length >= max) break
  }
  return due
}

/** 待入库行（§10.2 发时推）：已成功 / 已封口 / 缺必填的都不再选。对账补记行（backfill）没有
 *  book_id，服务端必填不齐——不推也不报错（ledger 仍是唯一权威，见 whale-push.mjs 头注）。 */
export const selectPendingIngest = (ledger, { max = 5 } = {}) => {
  const base = baseOf(ledger, 'posted')
  const rows = []
  for (const row of base.posted) {
    if (row.sent !== true || row.ingest_at || row.ingest_given_up) continue
    if (Number(row.ingest_attempts ?? 0) >= INGEST_MAX_ATTEMPTS) continue
    if (!String(row.book_id ?? '').trim() || !String(row.posted_at ?? '').trim()) continue
    if (!(Number(row.posted_ts) > 0)) continue
    rows.push(row)
    if (rows.length >= max) break
  }
  return rows
}

/** 失败 / 跳过事件（§10.1 事件码为基础集，可追加）。 */
export const withEvent = (ledger, rec) => {
  const base = baseOf(ledger, 'events')
  const at = String(rec?.tsOverride ?? '') || nowIso()
  const entry = {
    code: String(rec?.code ?? ''),
    bvid: rec?.bvid ? String(rec.bvid) : '',
    book_id: rec?.bookId ? String(rec.bookId) : '',
    detail: String(rec?.detail ?? '').slice(0, 200),
    at,
    ts: Date.parse(at) || 0,
  }
  if (!entry.code) return capLedger(base)
  return capLedger({ ...base, events: [...base.events, entry] })
}

/**
 * 对账补记（规格 §10.1 对账自愈的写侧）：guard 快照里缺记的 send 行由宿主补齐
 * 正文 / aid / mid 后从这里进账。要求 id 与 bvid 非空（guard 行身份），同 id 幂等。
 */
export const withBackfill = (ledger, entry) => {
  const base = baseOf(ledger, 'posted')
  const id = String(entry?.id ?? '')
  const bvid = String(entry?.bvid ?? '')
  if (!id || !bvid) return capLedger(base)
  if (base.posted.some((r) => r.id === id)) return capLedger(base)
  return capLedger({ ...base, posted: [...base.posted, { ...entry, id, bvid, backfill: true }] })
}

/**
 * guard 对账（§10.1）：kind='send' 且 status='sent' 的行与本 ledger 求差集。
 * 匹配：rpid 精确相等，或同 bvid 且 posted_at 落在同一个本地日（书评线同视频每日 ≤1 ⇒ 天级唯一）。
 * 返回缺记的 guard 行（调用方补正文 / aid / mid 后补写）。
 */
export const missingGuardSends = (guardRows, ledger) => {
  const base = baseOf(ledger, 'posted')
  const rows = Array.isArray(guardRows) ? guardRows : []
  const missing = []
  for (const row of rows) {
    if (!row || row.kind !== 'send' || row.status !== 'sent') continue
    const rpid = row.rpid !== undefined && row.rpid !== null && String(row.rpid) !== '' ? String(row.rpid) : ''
    const bvid = row.bvid !== undefined && row.bvid !== null && String(row.bvid) !== '' ? String(row.bvid) : ''
    const hit = base.posted.some((r) => {
      if (rpid && r.rpid === rpid) return true
      if (bvid && r.bvid === bvid) {
        const a = localDayOf(r.posted_at || (r.posted_ts ? new Date(r.posted_ts).toISOString() : ''))
        const b = localDayOf(row.at || '')
        if (a && a === b) return true
      }
      return false
    })
    if (!hit) missing.push(row)
  }
  return missing
}

/* ══════════════════════════════════════════════════════════════════════════════
 * 运行边界（T6 / 规格 §9.2 §9.4 §9.5）：停损、恢复档、降速、连败计数、V2 DOM 槽
 * ------------------------------------------------------------------------------
 * 判定逻辑在 lib/whale-bounds.mjs（纯函数）；这里只做形状与落账，保持「宿主写、模型不可见」。
 * 全部字段都挂在 ledger 顶层（stop/recovery/speed/fail_streak/unknown_streak），
 * capLedger 只裁 posted/events，不会动它们。
 * ══════════════════════════════════════════════════════════════════════════════ */
const STOP_LEVELS = ['L0', 'L1', 'L2', 'L3']
const isoMs = (value) => {
  const t = Date.parse(String(value ?? ''))
  return Number.isFinite(t) ? t : 0
}
const countOf = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0)

/**
 * 停损落账（§9.5）：机器写、未清除前不重复触发；清除后保留在账上做「同类信号再犯升一档」依据。
 * fail_streak / unknown_streak 随停损归零（恢复后从干净计数开始）。
 */
export const withStop = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  const at = String(rec?.at ?? '') || nowIso()
  const until = String(rec?.until ?? '')
  const entry = {
    level: STOP_LEVELS.includes(rec?.level) ? rec.level : 'L1',
    reason: String(rec?.reason ?? '').slice(0, 60),
    detail: String(rec?.detail ?? '').slice(0, 200),
    since: at,
    since_ts: Date.parse(at) || 0,
    until,
    until_ts: Number(rec?.until_ts) || isoMs(until),
    cleared_at: '',
    cleared_ts: 0,
    ack_at: '',
  }
  return capLedger({ ...base, stop: entry, fail_streak: 0, unknown_streak: 0 })
}

/** 人工核验后清停损（§9.5 恢复条件：停满 + 人工确认）；ackAt 留痕：谁签的时间点。 */
export const withStopCleared = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  if (!base.stop || base.stop.cleared_at) return base
  const at = String(rec?.at ?? '') || nowIso()
  return capLedger({
    ...base,
    stop: { ...base.stop, cleared_at: at, cleared_ts: Date.parse(at) || 0, ack_at: String(rec?.ackAt ?? ''), clear_note: String(rec?.note ?? '').slice(0, 120) },
    fail_streak: 0,
    unknown_streak: 0,
  })
}

/** 恢复档（§9.5：「恢复首日只发 1 条、24h 可见才回正常档」）：status pending ⇒ 上限 1 条/天。 */
export const withRecovery = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  const at = String(rec?.at ?? '') || nowIso()
  return capLedger({
    ...base,
    recovery: {
      started_at: at,
      started_ts: Date.parse(at) || 0,
      day: String(rec?.day ?? ''),
      cap: 1,
      status: 'pending',
      v1: '',
      resolved_at: '',
    },
  })
}

/** 恢复档结算（只由 V1 24h 判 hit 触发）：status ok ⇒ 回正常档；pending 保持 1 条/天。 */
export const withRecoveryResult = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  const cur = base.recovery
  if (!cur || typeof cur !== 'object') return base
  const at = String(rec?.at ?? '') || nowIso()
  const status = rec?.status === 'ok' ? 'ok' : 'pending'
  return capLedger({
    ...base,
    recovery: { ...cur, status, v1: String(rec?.v1 ?? cur.v1 ?? ''), resolved_at: status === 'ok' ? at : '' },
  })
}

/** 降速（§9.5 不停跑）：上限降到 1 条/天；本人复核后写 bounds.speedAck，由宿主调 withSpeedCleared。 */
export const withSpeed = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  if (base.speed?.downgraded) return base
  const at = String(rec?.at ?? '') || nowIso()
  return capLedger({
    ...base,
    speed: {
      downgraded: true,
      since: at,
      since_ts: Date.parse(at) || 0,
      reason: String(rec?.reason ?? '').slice(0, 60),
      cap: 1,
      cleared_at: '',
      cleared_ts: 0,
    },
  })
}

/** 人工复核后恢复降速（bounds.speedAck ≥ 降速起点）。 */
export const withSpeedCleared = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  if (!base.speed?.downgraded) return base
  const at = String(rec?.at ?? '') || nowIso()
  return capLedger({
    ...base,
    speed: { ...base.speed, downgraded: false, cleared_at: at, cleared_ts: Date.parse(at) || 0, clear_note: String(rec?.note ?? '').slice(0, 120) },
  })
}

/**
 * 发送结果计数（§9.5 的数据源）：
 *   ok=true ⇒ 归零；fail=true ⇒ fail_streak+1，unknown 单独连计；其余（pace/质量拦）不动计数
 *   —— 没真正发出的尝试不该把「连续发送失败」推高。
 */
export const withSendOutcome = (ledger, rec) => {
  const base = baseOf(ledger, 'posted')
  const prevFail = countOf(base.fail_streak)
  const prevUnknown = countOf(base.unknown_streak)
  if (rec?.ok === true) return capLedger({ ...base, fail_streak: 0, unknown_streak: 0 })
  if (rec?.fail !== true) return base
  const unknown = rec?.unknown === true
  return capLedger({ ...base, fail_streak: prevFail + 1, unknown_streak: unknown ? prevUnknown + 1 : 0 })
}

/** V2 DOM 核验槽（§10.4；生产者属 T5c/T7）。status: visible|hidden|unknown；unknown 不作判据。 */
export const withDomResult = (ledger, id, rec) => {
  const base = baseOf(ledger, 'posted')
  const at = String(rec?.at ?? '') || nowIso()
  return updatePostedAt(base, id, {
    v2_dom: {
      at,
      ts: Date.parse(at) || 0,
      status: ['visible', 'hidden', 'unknown'].includes(rec?.status) ? rec.status : 'unknown',
      how: String(rec?.how ?? '').slice(0, 80),
      note: String(rec?.note ?? '').slice(0, 160),
    },
  })
}

