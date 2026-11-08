/**
 * lib/whale-dom.mjs —— 鲸鱼书评线 V2 DOM 抽样核验（规格 §10.4；T5c/T7 折入）
 * ============================================================================
 * 判据只认页面 DOM：打开视频页 → 滚到 #end「没有更多评论」（证明完整加载）→ 穿 bili-comments
 * shadow DOM 按 data-user-profile-id 认领自己的评论并核对正文。
 *   · 完整加载 + 找到 = visible；完整加载 + 未找到 = hidden；
 *   · 未完整加载 / 页面打不开 / 没跑起来 = unknown（unknown 不作判据，见 §10.4）。
 * 浏览器：专用临时 profile（headless Chrome + mkdtemp 的 user-data-dir，用完整个删掉），
 * cookie 从 bili_credential.json 注入四个（SESSDATA/bili_jct/buvid3/dedeuserid），
 * 绝不复用日常浏览器登录态 —— 与旧引流线（ego-browser 继承用户登录）彻底隔离。
 * 纯判定/调度（judgeDomResult / pickV2Targets）离线可单测；probeDom 是 IO 壳（spawn + CDP）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sentRowsOf } from './whale-ledger.mjs'

export const V2_STATUSES = Object.freeze(['visible', 'hidden', 'unknown'])
export const NO_MORE_COMMENTS = '没有更多评论'
/** 每轮最多核几条（§10.4 上限 3 条/天）。 */
export const V2_DAILY_MAX = 3
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/** 本机 Chrome 可执行文件（找不到就 null；调用方按 unknown 处理，不猜路径）。 */
export const findChrome = ({ env = process.env, exists = existsSync } = {}) => {
  if (env.WHALE_CHROME_PATH && exists(env.WHALE_CHROME_PATH)) return env.WHALE_CHROME_PATH
  for (const p of CHROME_CANDIDATES) if (exists(p)) return p
  return null
}

const localDayStart = (ts) => {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * V2 该核哪几条（§10.4 触发口径）：
 *   ① V1 判 miss / invisible 的行（待复核，最优先）；
 *   ② 每天随机 1 条（当天还没有 v2_dom 结果时补一条；随机源可注入）。
 * 已经核过的行不重核；单次最多 max 条。
 */
export const pickV2Targets = (ledger, { nowTs = Date.now(), max = V2_DAILY_MAX, random = Math.random } = {}) => {
  const sent = sentRowsOf(ledger)
  const pending = sent.filter((row) => !row?.v2_dom)
  if (!pending.length) return []
  const v1Flagged = pending.filter((row) => ['v1_30min', 'v1_24h'].some((slot) => {
    const st = String(row?.[slot]?.status ?? '')
    return st === 'miss' || st === 'invisible'
  }))
  if (v1Flagged.length) return v1Flagged.slice(0, max).map((row) => ({ id: String(row.id), bvid: String(row.bvid ?? ''), rpid: String(row.rpid ?? ''), reason: 'v1-miss' }))
  const dayStart = localDayStart(nowTs)
  const sampledToday = sent.some((row) => Number(row?.v2_dom?.ts) >= dayStart)
  if (sampledToday) return []
  const idx = Math.min(pending.length - 1, Math.floor(random() * pending.length))
  const row = pending[idx]
  return [{ id: String(row.id), bvid: String(row.bvid ?? ''), rpid: String(row.rpid ?? ''), reason: 'daily-sample' }]
}

/**
 * 把 DOM 探针原始回包判成三态（§10.4 判据原文；错一点都不下 hidden 结论）。
 * raw: { ok, url, mount_tries, scroll_loops, complete, threads, mine:[{head,length,has_quark,has_baidu}], error }
 */
export const judgeDomResult = (raw, { mid = '', hook = '' } = {}) => {
  if (!raw || raw.ok !== true) {
    return { status: 'unknown', how: 'dom:error', note: '探针没跑起来：' + String(raw?.error ?? 'no-result').slice(0, 130) }
  }
  if (raw.complete !== true) {
    return { status: 'unknown', how: 'dom:incomplete', note: '列表未完整加载（#end 未出现「' + NO_MORE_COMMENTS + '」，threads=' + Number(raw.threads || 0) + '，scroll_loops=' + Number(raw.scroll_loops || 0) + '）' }
  }
  const mine = Array.isArray(raw.mine) ? raw.mine : []
  if (!mine.length) {
    return { status: 'hidden', how: 'dom:complete-not-found', note: '列表完整加载（threads=' + Number(raw.threads || 0) + '），但 DOM 里没有 mid=' + String(mid) + ' 的评论' }
  }
  const head = Array.from(String(hook ?? '')).slice(0, 12).join('')
  const matched = head ? mine.some((m) => String(m?.head ?? '').includes(head)) : false
  return {
    status: 'visible',
    how: 'dom:found',
    note: matched
      ? '完整加载 + 找到本人评论，正文含钩子前 12 字'
      : '完整加载 + 找到 ' + mine.length + ' 条本人评论' + (head ? '，但正文未匹配钩子前缀（人工复核）' : ''),
  }
}

/** 页面内三步法探针源码（lib/whale-dom-probe.js，占位符在 probeExpression 里替换）。 */
const PROBE_SOURCE = (() => {
  try { return readFileSync(new URL('./whale-dom-probe.js', import.meta.url), 'utf8') } catch { return '' }
})()

export const probeExpression = ({ mid, endText = NO_MORE_COMMENTS, maxScroll = 30 } = {}) => {
  if (!PROBE_SOURCE) throw new Error('找不到 lib/whale-dom-probe.js（V2 探针源码缺失）')
  return PROBE_SOURCE
    .replaceAll('__MID__', () => JSON.stringify(String(mid)))
    .replaceAll('__END__', () => JSON.stringify(String(endText)))
    .replaceAll('__MAXSCROLL__', () => String(Number(maxScroll) || 30))
}

/* ── CDP 小客户端（Node >=22 / Electron >=44 自带全局 WebSocket；不加第三方依赖） ── */
const openWs = (url, wsImpl = globalThis.WebSocket) => new Promise((resolve, reject) => {
  if (typeof wsImpl !== 'function') return reject(new Error('这个 Node 没有全局 WebSocket（需要 >=22）'))
  const ws = new wsImpl(url)
  const fail = (e) => { try { ws.close() } catch {} ; reject(e instanceof Error ? e : new Error(String(e?.message ?? e))) }
  ws.addEventListener('open', () => resolve(ws), { once: true })
  ws.addEventListener('error', (e) => fail(new Error('CDP WebSocket error：' + String(e?.message ?? e?.error?.message ?? 'unknown'))), { once: true })
  ws.addEventListener('close', () => fail(new Error('CDP WebSocket 提前关闭')), { once: true })
})

const cdpClient = (ws, timeoutMs = 60000) => {
  let seq = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (ev) => {
    let msg = null
    try { msg = JSON.parse(String(ev.data)) } catch { return }
    if (msg?.id != null && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) entry.reject(new Error('CDP ' + String(msg.error?.message ?? 'error')))
      else entry.resolve(msg.result)
      return
    }
    if (msg?.method) for (const fn of listeners) { try { fn(msg) } catch {} }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 超时：' + method)) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try { ws.send(JSON.stringify({ id, method, params })) } catch (e) { clearTimeout(timer); pending.delete(id); reject(e) }
  })
  const waitEvent = (method, ms = 45000) => new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; listeners.delete(fn); resolve(false) } }, ms)
    const fn = (msg) => { if (done || msg.method !== method) return; done = true; clearTimeout(timer); listeners.delete(fn); resolve(true) }
    listeners.add(fn)
  })
  return { send, waitEvent, close: () => { for (const entry of pending.values()) { clearTimeout(entry.timer); try { entry.reject(new Error('CDP 关闭')) } catch {} } pending.clear(); try { ws.close() } catch {} } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 Chrome 写 DevToolsActivePort（第一行端口）；起不来就抛错（由 probeDom 落 unknown）。 */
const waitDevToolsPort = async (file, { timeoutMs = 20000, read = readFileSync } = {}) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const lines = String(read(file, 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean)
      const port = Number(lines[0])
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* 还没写出来 */ }
    await sleep(150)
  }
  throw new Error('Chrome 没写出 DevToolsActivePort（起没来）')
}

/**
 * 真机探针：起临时 profile 的 headless Chrome → 注入鲸鱼 cookie → 打开视频页 → 三步法。
 * 任何一步失败都回 { ok:false, error }，由 judgeDomResult 落成 unknown（不误判 hidden）。
 * 依赖注入：spawn/ws/fetch/exists/read/rm 都可替换（单测不碰真浏览器）。
 */
export const probeDom = async ({
  bvid,
  rpid = '',
  mid,
  cred,
  chromePath,
  timeoutMs = 240000,
  loadWaitMs = 45000,
  log = () => {},
  spawnImpl = spawn,
  wsImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  exists = existsSync,
  read = readFileSync,
  rm = rmSync,
  mkdtemp = mkdtempSync,
  find = findChrome,
} = {}) => {
  const bv = String(bvid ?? '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) return { ok: false, error: 'bvid 不合法：' + bv.slice(0, 24) }
  const exe = chromePath || find()
  if (!exe || !exists(exe)) return { ok: false, error: '找不到 Chrome 可执行文件（可用 WHALE_CHROME_PATH 指定）' }
  const dir = mkdtemp(join(tmpdir(), 'whale-dom-'))
  let child = null
  let cdp = null
  try {
    child = spawnImpl(exe, [
      '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*',
      '--user-data-dir=' + join(dir, 'profile'), '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--disable-extensions', '--disable-sync', '--disable-background-networking',
      '--hide-scrollbars', '--mute-audio', '--window-size=1280,900', '--user-agent=' + UA,
      'about:blank',
    ], { stdio: 'ignore' })
    const port = await waitDevToolsPort(join(dir, 'profile', 'DevToolsActivePort'), { read })
    const createdResp = await fetchImpl('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })
    const created = await createdResp.json()
    const targetUrl = String(created?.webSocketDebuggerUrl || '')
    if (!targetUrl) throw new Error('CDP /json/new 没给 webSocketDebuggerUrl')
    const ws = await openWs(targetUrl, wsImpl)
    cdp = cdpClient(ws, 60000)
    await cdp.send('Network.enable')
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const cookies = [
      ['SESSDATA', cred?.sessdata], ['bili_jct', cred?.bili_jct],
      ['buvid3', cred?.buvid3], ['dedeuserid', cred?.dedeuserid],
    ]
    for (const pair of cookies) {
      const name = pair[0]
      const value = pair[1]
      if (!value) continue
      await cdp.send('Network.setCookie', { name: name, value: String(value), domain: '.bilibili.com', path: '/', secure: true, httpOnly: false })
    }
    const loaded = cdp.waitEvent('Page.loadEventFired', loadWaitMs)
    await cdp.send('Page.navigate', { url: 'https://www.bilibili.com/video/' + bv + '/' })
    await loaded
    log('whale V2：页面已加载 ' + bv + (rpid ? '（rpid=' + rpid + '）' : ''))
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: probeExpression({ mid }),
      awaitPromise: true, returnByValue: true, userGesture: true,
      timeout: Math.max(30000, Number(timeoutMs) || 240000),
    })
    if (evaluated?.exceptionDetails) return { ok: false, error: '探针表达式抛错：' + String(evaluated.exceptionDetails?.text ?? 'exception') }
    const value = evaluated?.result?.value
    if (!value || typeof value !== 'object') return { ok: false, error: '探针没回结构化结果' }
    return value
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) }
  } finally {
    try { if (cdp) cdp.close() } catch { /* 关 ws 失败不致命 */ }
    try { if (child) child.kill('SIGKILL') } catch { /* 已退出 */ }
    try { rm(dir, { recursive: true, force: true }) } catch { /* 临时目录删不掉不致命 */ }
  }
}
