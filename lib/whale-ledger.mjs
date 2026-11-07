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
import { readJson, writeJson } from './state.mjs'

export const WHALE_LEDGER_DIR = 'whale-book-comment'

/** posted / events 的封顶：书评线 3–5 条/天，2000 ≈ 一年多的量，防失控（照 dup.mjs 口径） */
export const WHALE_LEDGER_MAX = 2000

export const whaleLedgerFile = (stateDir) => join(stateDir, WHALE_LEDGER_DIR, 'ledger.json')

export const emptyLedger = () => ({ version: 1, posted: [], events: [] })

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
  const disk = /pan\.baidu\.com/.test(s) ? 'baidu' : /pan\.quark\.cn/.test(s) ? 'quark' : ''
  return { url, code, disk }
}

/* ── 求赞行（WP2 的 like_line 列）：钩子里单独一行「求个赞/求三连」之类的尾巴 ── */
const LIKE_LINE_RE = /求[^，。！!？?\n]{0,8}(赞|三连|关注)/
export const likeLineOf = (hook) => {
  const lines = String(hook ?? '').split('\n')
  return lines.reverse().find((l) => LIKE_LINE_RE.test(l))?.trim() || ''
}

const localDayKey = (value) => {
  const d = value instanceof Date ? value : new Date(String(value ?? ''))
  return Number.isFinite(d?.getTime()) ? d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() : ''
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

const withCap = (ledger) => capLedger(ledger)

/** WP1 书源门命中。幂等：同 id 只更新 gate 字段（批准重放/重试不重复建行）。 */
export const withGateHit = (ledger, rec) => {
  const base = ledger && typeof ledger === 'object' && Array.isArray(ledger.posted) ? ledger : emptyLedger()
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
    gate_hit_at: at,
    gate_hit_ts: Date.parse(at) || 0,
  }
  if (!entry.id) return withCap(base)
  const i = base.posted.findIndex((r) => r.id === entry.id)
  const posted = [...base.posted]
  if (i >= 0) posted[i] = { ...posted[i], ...entry }
  else posted.push(entry)
  return withCap({ ...base, posted })
}

/** WP2 发前：hook / block / order_kind / like_line / 字数。记录不存在时忽略（WP1 一定先发生）。 */
export const withBeforeSend = (ledger, id, rec) => {
  const base = ledger && typeof ledger === 'object' && Array.isArray(ledger.posted) ? ledger : emptyLedger()
  const i = base.posted.findIndex((r) => r.id === String(id ?? ''))
  if (i < 0) return base
  const block = String(rec?.block ?? '')
  const entry = {
    hook: String(rec?.hook ?? ''),
    block,
    order_kind: parseBlockContact(block).disk,
    like_line: likeLineOf(rec?.hook),
    char_count: Number(rec?.charCount) || 0,
    before_send_at: nowIso(),
  }
  const posted = [...base.posted]
  posted[i] = { ...posted[i], ...entry }
  return withCap({ ...base, posted })
}

/** WP3 发后：rpid（十进制字符串，原样保留）/ guard_status / posted_at / posted_ts。 */
export const withAfterSend = (ledger, id, rec) => {
  const base = ledger && typeof ledger === 'object' && Array.isArray(ledger.posted) ? ledger : emptyLedger()
  const i = base.posted.findIndex((r) => r.id === String(id ?? ''))
  if (i < 0) return base
  const postedAt = rec?.postedAt || (rec?.sent === true ? nowIso() : '')
  const entry = {
    rpid: String(rec?.rpid ?? ''),
    guard_status: String(rec?.guardStatus ?? ''),
    sent: rec?.sent === true,
    error_code: rec?.errorCode ?? null,
    posted_at: postedAt,
    posted_ts: postedAt ? (Date.parse(postedAt) || 0) : 0,
  }
  const posted = [...base.posted]
  posted[i] = { ...posted[i], ...entry }
  return withCap({ ...base, posted })
}

/** 失败 / 跳过事件（§10.1 事件码为基础集，可追加）。 */
export const withEvent = (ledger, rec) => {
  const base = ledger && typeof ledger === 'object' && Array.isArray(ledger.events) ? ledger : emptyLedger()
  const at = String(rec?.tsOverride ?? '') || nowIso()
  const entry = {
    code: String(rec?.code ?? ''),
    bvid: rec?.bvid ? String(rec.bvid) : '',
    book_id: rec?.bookId ? String(rec.bookId) : '',
    detail: String(rec?.detail ?? '').slice(0, 200),
    at,
    ts: Date.parse(at) || 0,
  }
  if (!entry.code) return withCap(base)
  return withCap({ ...base, events: [...base.events, entry] })
}

/**
 * guard 对账（§10.1）：kind='send' 且 status='sent' 的行与本 ledger 求差集。
 * 匹配：rpid 精确相等，或同 bvid 且 posted_at 落在同一个本地日（书评线同视频每日 ≤1 ⇒ 天级唯一）。
 * 返回缺记的 guard 行（调用方补正文 / aid / mid 后补写）。
 */
export const missingGuardSends = (guardRows, ledger) => {
  const base = ledger && typeof ledger === 'object' && Array.isArray(ledger.posted) ? ledger : emptyLedger()
  const rows = Array.isArray(guardRows) ? guardRows : []
  const missing = []
  for (const row of rows) {
    if (!row || row.kind !== 'send' || row.status !== 'sent') continue
    const rpid = row.rpid !== undefined && row.rpid !== null && String(row.rpid) !== '' ? String(row.rpid) : ''
    const bvid = row.bvid !== undefined && row.bvid !== null && String(row.bvid) !== '' ? String(row.bvid) : ''
    const hit = base.posted.some((r) => {
      if (rpid && r.rpid === rpid) return true
      if (bvid && r.bvid === bvid) {
        const a = localDayKey(r.posted_at || (r.posted_ts ? new Date(r.posted_ts).toISOString() : ''))
        const b = localDayKey(row.at || '')
        if (a && a === b) return true
      }
      return false
    })
    if (!hit) missing.push(row)
  }
  return missing
}
