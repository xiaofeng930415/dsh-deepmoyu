/** Read-only post-send checks. A bounded list miss never proves a send failed. */
import { constants, existsSync, readFileSync, openSync, appendFileSync, closeSync, fsyncSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './state.mjs'
import { normalizeId, optionalId, readableId, parseJsonExactIntegers } from './ids.mjs'
import { atomicWriteFileSync, readJsonFileSync, withFileLockSync } from './record-storage.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const bounded = (n, fallback, ceiling) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, ceiling) : fallback

/** IDs remain decimal strings, including 19-digit IDs in old Markdown ledgers. */
export function parseSeen(text) {
  const rows = []
  for (const line of String(text).split(/\r?\n/)) {
    const bv = /\bBV[0-9A-Za-z]{10}\b/.exec(line)
    if (!bv) continue
    const ids = [...line.matchAll(/\b(\d{9,})\b/g)].map(m => m[1])
    if (!ids.length) continue
    const rpid = readableId(ids[0], { allowZero: false })
    const root = ids.length > 1 ? readableId(ids[1]) : '0'
    if (rpid && root) rows.push({ bv: bv[0], rpid, root, line: line.trim().slice(0, 160) })
  }
  return rows
}

export function loadCredential(stateDir) {
  try {
    const value = readJsonFileSync(join(stateDir, 'bili_credential.json'), null)
    return typeof value?.sessdata === 'string' && value.sessdata ? value : null
  } catch { return null }
}

export function headersFor(cred) {
  const parts = [`SESSDATA=${cred.sessdata}`]
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  return { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: parts.join('; ') }
}

async function jget(url, headers, { fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok === false) return { code: -997 }
    try { return parseJsonExactIntegers(await response.text()) } catch { return { code: -999 } }
  } catch { return { code: -998 } }
}

/** The authenticated list is evidence, not an anonymous/public visibility guarantee. */
function found(out, hit) {
  const hidden = ![undefined, null, false, 0, '0', 'false'].includes(hit.invisible)
  out.visible = !hidden
  if (Number.isSafeInteger(hit.like) && hit.like >= 0) out.likes = hit.like
  out.note = hidden ? '接口标记 invisible，不能认定公开可见' : '本次登录态的评论列表可见；不代表所有访客都能看到'
  return out
}

/**
 * reply/detail 整包返回（规格 docs/spec-whale-bili-book-comment.md §10.3）：只用于取 floor/like/rcount
 * （仅 code=0 时 data.root 有值），**不作可见性判据**——它对公开评论稳定误报 12006。
 */
export async function replyDetail(aid, rpid, { headers, fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  return jget('https://api.bilibili.com/x/v2/reply/detail?type=1&oid=' + aid + '&root=' + rpid, headers, { fetchImpl, timeoutMs })
}

/** Check at most three pages by default; dependencies are injectable for offline QA. */
export async function verifyOne(record, { cred, aidCache = new Map(), headers = cred ? headersFor(cred) : {}, fetchImpl = globalThis.fetch, sleepImpl = sleep, timeoutMs = 10000, maxPages = 3 } = {}) {
  const rpid = normalizeId(record.rpid, { allowZero: false }), root = optionalId(record.root)
  if (!/^BV[0-9A-Za-z]{10}$/.test(record.bv)) throw new TypeError('VERIFY_INVALID_BVID')
  const out = { rpid, bv: record.bv, visible: null, how: '', note: '' }
  const io = { fetchImpl, timeoutMs: bounded(timeoutMs, 10000, 30000) }, pages = bounded(maxPages, 3, 5)
  if (!aidCache.has(record.bv)) {
    const value = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${record.bv}`, headers, io)
    const aid = value?.code === 0 ? readableId(value.data?.aid, { allowZero: false }) : ''
    aidCache.set(record.bv, aid ? { aid } : null)
    await sleepImpl(300)
  }
  const meta = aidCache.get(record.bv)
  const aid = readableId(meta?.aid, { allowZero: false })
  if (!aid) return { ...out, how: '取视频信息失败', note: '这条跳过（视频可能已删、不可见或接口暂不可用）' }
  let next = '0'
  const cursors = new Set()
  for (let page = 1; page <= pages; page++) {
    const url = root === '0'
      ? `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=${next}&ps=20`
      : `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root}&ps=20&pn=${page}`
    const value = await jget(url, headers, io)
    out.how = root === '0' ? `顶层·按时间前 ${page} 页` : `楼中楼·root=${root}·前 ${page} 页`
    if (value?.code !== 0 || !value.data || typeof value.data !== 'object') {
      out.note = '评论接口暂不可用，本次无法判断（不等于没发出去）'
      return out
    }
    const list = Array.isArray(value.data.replies) ? value.data.replies : []
    const hit = list.find(row => readableId(row?.rpid_str ?? row?.rpid, { allowZero: false }) === rpid)
    if (hit) return found(out, hit)
    if (root === '0') {
      const cursor = value.data.cursor
      const following = readableId(cursor?.next)
      if (cursor?.is_end || !following || following === '0' || following === next || cursors.has(following)) break
      cursors.add(next); next = following
    } else {
      const count = value.data.page?.count
      if (list.length < 20 || (Number.isSafeInteger(count) && page * 20 >= count)) break
    }
    if (page < pages) await sleepImpl(200)
  }
  out.note = '已检查的页面里没查到；可能在审核，也可能在其他页（不等于没发出去）'
  return out
}

function readState(file) {
  const value = readJsonFileSync(file, {})
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('VERIFY_STATE_INVALID')
  return value
}

/** Merge results under the shared transaction; corrupt history is never reset. */
export async function verifyRecent(stateDir, { max = 6, log = () => {}, ...io } = {}) {
  const seenFile = join(stateDir, 'seen.md')
  if (!existsSync(seenFile)) return { checked: [], skipped: 0, text: '⚠️ 判重表还没生成，没什么可复核的' }
  const cred = loadCredential(stateDir)
  if (!cred) return { checked: [], skipped: 0, text: '⚠️ 还没扫码登录，没法复核（复核要用你自己的登录态）' }
  const rows = parseSeen(readFileSync(seenFile, 'utf8'))
  if (!rows.length) return { checked: [], skipped: 0, text: '判重表里没有可复核的评论记录' }
  const stateFile = join(stateDir, 'verify-state.json'), state = readState(stateFile), now = Date.now()
  const fresh = [], identities = new Set()
  let skipped = 0
  for (const row of rows.slice().reverse()) {
    const key = `${row.bv}:${row.rpid}`
    if (identities.has(key)) { skipped++; continue }
    identities.add(key)
    const prev = state[row.rpid]
    if (prev?.bv === row.bv && prev.visible === true && Number.isFinite(prev.at) && prev.at <= now && now - prev.at < 7 * 864e5) { skipped++; continue }
    fresh.push(row)
    if (fresh.length >= bounded(max, 6, 50)) break
  }
  if (!fresh.length) return { checked: [], skipped, text: `都复核过了（跳过的旧记录 ${skipped} 条）` }
  const aidCache = new Map(), checked = [], updates = {}
  for (const row of fresh) {
    const result = await verifyOne(row, { ...io, cred, aidCache, headers: headersFor(cred) })
    checked.push(result)
    updates[row.rpid] = { visible: result.visible, at: Date.now(), how: result.how, bv: row.bv, likes: result.likes ?? null }
    try { log(`复核 ${row.bv} rpid=${row.rpid} → ${result.visible === true ? '列表可见' : result.visible === false ? '接口标记不可见' : '没查到'}（${result.how}）`) } catch { /* diagnostics are optional */ }
    await (io.sleepImpl || sleep)(700)
  }
  withFileLockSync(stateFile, () => {
    const latest = readState(stateFile)
    for (const [id, result] of Object.entries(updates)) if (!(latest[id]?.at > result.at)) latest[id] = result
    atomicWriteFileSync(stateFile, JSON.stringify(latest, null, 2))
  })
  const lines = ['', '## 评论复核（宿主自动跑的，不是那一轮自己说的）', '']
  for (const result of checked) {
    const status = result.visible === true ? `列表可见（赞 ${result.likes ?? 0}）` : result.visible === false ? '接口标记不可见' : '没查到'
    lines.push(`- \`${result.bv}\` rpid **${result.rpid}** —— ${status} · 依据：${result.how}${result.note ? ' · ' + result.note : ''}`)
  }
  if (skipped) lines.push(`- （另外 ${skipped} 条重复或近期已复核的记录，没有重复查）`)
  return { checked, skipped, text: lines.join('\n') }
}

/** O_APPEND preserves concurrent report appends; never read/rewrite an evolving report. */
export function appendVerifyToReport(stateDir, text) {
  const file = join(stateDir, 'out', `${dayKey()}.md`)
  let fd
  try {
    fd = openSync(file, constants.O_WRONLY | constants.O_APPEND)
    appendFileSync(fd, `\n${String(text)}\n`, 'utf8'); fsyncSync(fd)
    return file
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

if (process.argv[1] && /verify\.mjs$/.test(process.argv[1])) {
  const dir = process.argv[2] || join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'bili-duty')
  const result = await verifyRecent(dir, { log: value => console.log('  ' + value) })
  console.log(result.text)
}
