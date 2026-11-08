import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

const NL = String.fromCharCode(10)
const BV = 'BV1234567890', UID = '3707002496747705', SENT = '6789012345678901234'
const HOOK = '讲复利那三分钟本鱼来回听了三遍，数字一减就懂了，嘿嘿。'
const BLOCK = ['鲸鱼整理的《合成的书名》资源包', 'https://pan.quark.cn/s/synthetic', '提取码：sx12'].join(NL)
const GATE_FOUND = { ok: true, found: true, source: 'ledger', bookId: 'synthetic-book', bookTitle: '合成的书名', disk: 'quark', block: BLOCK, blockLen: [...BLOCK].length, fromLedger: true }
const flush = () => new Promise(resolve => setImmediate(resolve))

test('book review queues the final composed bytes and approval sends them without rerunning the gate (spec §5.3)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-book-review-')), home = join(dir, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: true, autoComment: true, replyToComments: false, autoReplyDm: false, autoMoment: false, learnAutoReview: false, reportLevel: 'off', pythonPath: 'synthetic-python' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ unrelated: 61 }))
  const cleanups = [], tools = new Map(), calls = [], spawns = []
  const agent = { id: 'book-review-fish', session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (name === 'bili_video_info') return { bvid: BV, title: '合成的讲书视频', owner: { mid: UID } }
    if (name === 'bili_reply') return { success: true, rpid_str: SENT }
    throw new Error('UNEXPECTED_MCP_CALL: ' + name)
  }
  const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn
  cp.spawn = (command, args) => {
    spawns.push({ command, args })
    if (String(args?.[0] ?? '').endsWith('client.py')) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(GATE_FOUND))); child.emit('close', 0) })
      return child
    }
    throw new Error('UNEXPECTED_SUBPROCESS: ' + String(command))
  }; syncBuiltinESMExports()
  let handler
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = Buffer.isBuffer(value) ? value : value ? JSON.parse(value) : {} } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return res
  }
  try {
    apply(ctx, {}); await flush()
    const execute = (name, args, exec = { agent }) => tools.get(name).execute(args, exec)
    const queued = await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    assert.equal(queued.queued, true, JSON.stringify(queued))
    assert.ok(!JSON.stringify(queued).includes('pan.quark'), '排队回执不得泄漏口令块')
    assert.equal(spawns.length, 1, 'gate 在入预览队列之前跑且只跑一次')
    assert.ok(calls.some(row => row.name === 'bili_video_info'), '发送前先取 UP uid')
    assert.ok(!calls.some(row => row.name === 'bili_reply'), '批准前一个字都不发')
    const review = (await request('/send-review')).body
    const [row] = review.items
    assert.equal(row.tool, 'bili_book_comment')
    assert.equal(row.kind, '书评')
    assert.equal(row.args.text, HOOK + NL + BLOCK, '预览即最终字节（含口令块，§5.3）')
    assert.equal(row.args.bookId, 'synthetic-book')
    assert.equal(row.args.hook, HOOK)
    assert.equal(row.args.picture, '', 'sendReview 期间自动配图失效（§9.3）')
    assert.equal(review.counts.pending, 1)
    const sent = await request('/send-review', { id: row.id, decision: 'approve', expectedHash: row.hash })
    assert.equal(sent.body.sent, true, JSON.stringify(sent.body))
    assert.equal(spawns.length, 1, '批准重放不得再跑 gate（§5.3）')
    const sentCall = calls.find(item => item.name === 'bili_reply')
    assert.equal(sentCall.args.text, HOOK + NL + BLOCK)
    assert.equal(sentCall.args.rpid, '0')
    assert.equal(sent.body.item.result.book_comment.bookId, 'synthetic-book')
    const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.ok(st.repliedComments['nu:' + BV], 'nu: 键由发送链照旧写')
    assert.ok(st.repliedComments['book:synthetic-book'], 'book: 键只在发送成功后写')
    assert.equal(st.repliedComments['book:synthetic-book'].bvid, BV)
    assert.ok(st.repliedComments['up:' + UID], 'up: 键只在发送成功后写')
    assert.equal(st.repliedComments['up:' + UID].uid, UID)
    assert.equal(st.unrelated, 61, '原有 state 字段不被破坏')
    assert.equal((await request('/status')).body.sendReview.counts.sent, 1)
    // 📇 规格 §10.1：本地 ledger 三写入点一次走全（宿主写、含链接，模型不可见）
    const ledger = JSON.parse(readFileSync(join(home, 'whale-book-comment', 'ledger.json'), 'utf8'))
    assert.equal(ledger.posted.length, 1, JSON.stringify(ledger))
    const rec = ledger.posted[0]
    assert.equal(rec.book_id, 'synthetic-book')
    assert.equal(rec.link, 'https://pan.quark.cn/s/synthetic', 'WP1 的 link 从口令块解析')
    assert.equal(rec.code, 'sx12')
    assert.equal(rec.disk, 'quark')
    assert.equal(rec.from_ledger, true)
    assert.equal(rec.hook, HOOK)
    assert.equal(rec.order_kind, 'quark')
    assert.equal(rec.like_line, '')
    assert.ok(rec.char_count >= HOOK.length + BLOCK.length)
    assert.equal(rec.rpid, SENT)
    assert.equal(rec.guard_status, 'sent')
    assert.ok(rec.posted_ts > 0)
  } finally {
    for (const fn of cleanups.reverse()) try { fn() } catch {}
    cp.spawn = originalSpawn; syncBuiltinESMExports(); McpClient.prototype.call = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('book review reject keeps the claim result unused and sends nothing; permissions off skips the gate entirely', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-book-review-off-')), home = join(dir, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: true, autoComment: true, replyToComments: false, autoReplyDm: false, autoMoment: false, learnAutoReview: false, reportLevel: 'off', pythonPath: 'synthetic-python' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({}))
  const cleanups = [], tools = new Map(), calls = [], spawns = []
  const agent = { id: 'book-review-fish-2', session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (name === 'bili_video_info') return { bvid: BV, title: '合成的讲书视频', owner: { mid: UID } }
    if (name === 'bili_reply') return { success: true, rpid_str: SENT }
    throw new Error('UNEXPECTED_MCP_CALL: ' + name)
  }
  const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn
  cp.spawn = (command, args) => {
    spawns.push({ command, args })
    if (String(args?.[0] ?? '').endsWith('client.py')) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(GATE_FOUND))); child.emit('close', 0) })
      return child
    }
    throw new Error('UNEXPECTED_SUBPROCESS: ' + String(command))
  }; syncBuiltinESMExports()
  let handler
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = Buffer.isBuffer(value) ? value : value ? JSON.parse(value) : {} } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return res
  }
  try {
    apply(ctx, {}); await flush()
    const execute = (name, args, exec = { agent }) => tools.get(name).execute(args, exec)
    await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    const [row] = (await request('/send-review')).body.items
    const rejected = await request('/send-review', { id: row.id, decision: 'reject', expectedHash: row.hash })
    assert.equal(rejected.body.ok, true)
    assert.equal(rejected.body.item.state, 'rejected')
    assert.ok(!calls.some(item => item.name === 'bili_reply'), '拒绝后一个字都不发')
    const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    const keys = Object.keys(st.repliedComments || {})
    assert.ok(!keys.some(key => key.startsWith('book:') || key.startsWith('up:') || key === 'nu:' + BV), '拒绝不写任何判重键（claim 结果等下次 gate 复用）')
    const wl = JSON.parse(readFileSync(join(home, 'whale-book-comment', 'ledger.json'), 'utf8'))
    assert.equal(wl.posted.length, 1, 'WP1 在组合成功时已建行')
    assert.ok(!wl.posted[0].rpid, '拒绝后没有发后字段')
    assert.ok(wl.events.some(e => e.code === 'skipped:review-rejected'), '拒绝事件留痕')
    // 关掉 autoComment：连 gate 都不跑（claim 有不可逆副作用，未授权不空跑）
    await request('/config', { autoComment: false })
    const before = spawns.length
    const off = await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    assert.equal(off.blocked, true)
    assert.equal(spawns.length, before, '未授权时书源门不空跑')
    assert.ok(!calls.some(item => item.name === 'bili_reply'))
  } finally {
    for (const fn of cleanups.reverse()) try { fn() } catch {}
    cp.spawn = originalSpawn; syncBuiltinESMExports(); McpClient.prototype.call = original
    rmSync(dir, { recursive: true, force: true })
  }
})

test('T6 bounds: first 3 sends force review even with sendReview off; daily cap and stop-loss block before the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fish-book-bounds-')), home = join(dir, 'bili-duty')
  mkdirSync(home)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: false, autoComment: true, replyToComments: false, autoReplyDm: false, autoMoment: false, learnAutoReview: false, reportLevel: 'off', pythonPath: 'synthetic-python' }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({}))
  const cleanups = [], tools = new Map(), calls = [], spawns = []
  const agent = { id: 'book-bounds-fish', session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (name === 'bili_video_info') return { bvid: BV, title: '合成的讲书视频', owner: { mid: UID } }
    if (name === 'bili_reply') return { success: true, rpid_str: SENT }
    throw new Error('UNEXPECTED_MCP_CALL: ' + name)
  }
  const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn
  cp.spawn = (command, args) => {
    spawns.push({ command, args })
    if (String(args?.[0] ?? '').endsWith('client.py')) {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true
      queueMicrotask(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(GATE_FOUND))); child.emit('close', 0) })
      return child
    }
    throw new Error('UNEXPECTED_SUBPROCESS: ' + String(command))
  }; syncBuiltinESMExports()
  let handler
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const request = async (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = headers; req.destroy = () => {}
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = Buffer.isBuffer(value) ? value : value ? JSON.parse(value) : {} } }
    const promise = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return res
  }
  const ledgerFile = join(home, 'whale-book-comment', 'ledger.json')
  mkdirSync(join(home, 'whale-book-comment'), { recursive: true })
  const writeLedger = (value) => writeFileSync(ledgerFile, JSON.stringify({ version: 1, posted: [], events: [], ...value }))
  const readLedger = () => JSON.parse(readFileSync(ledgerFile, 'utf8'))
  try {
    apply(ctx, {}); await flush()
    const execute = (name, args, exec = { agent }) => tools.get(name).execute(args, exec)
    /* ① 首 3 条（§9.3）：sendReview 关着也必须人工批准 —— 强制进预览队列，不直发 */
    const queued = await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    assert.equal(queued.queued, true, JSON.stringify(queued))
    assert.equal(queued.forced, true, '首 3 条 forced 标记')
    assert.ok(!calls.some(row => row.name === 'bili_reply'), '未批准前一个字都不发')
    assert.equal((await request('/send-review')).body.counts.pending, 1, '内容在预览队列里等本人点头')
    /* ② 每日上限（§9.2）：预置今天 3 条已发 ⇒ 拒绝并记 skipped:daily-cap，连书源门都不跑 */
    const now = Date.now()
    writeLedger({ posted: [0, 1, 2].map((i) => ({ id: 'wl-cap-' + i, bvid: 'BV000000000' + i, sent: true, rpid: String(900 + i), posted_at: new Date(now - i * 60_000).toISOString(), posted_ts: now - i * 60_000 })) })
    const before = spawns.length
    const capped = await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    assert.equal(capped.blocked, true, JSON.stringify(capped))
    assert.match(String(capped.hint), /上限/)
    assert.equal(spawns.length, before, '达限时不跑书源门（更不会 claim）')
    assert.ok(readLedger().events.some(e => e.code === 'skipped:daily-cap'), '达限事件留痕')
    /* ③ 停损（§9.5 L1）：未到期的停损 ⇒ 拒绝 + 事件 + 不跑书源门 */
    const untilTs = now + 24 * 3600_000
    writeLedger({ stop: { level: 'L1', reason: 'risk-code', since: new Date(now - 60_000).toISOString(), since_ts: now - 60_000, until: new Date(untilTs).toISOString(), until_ts: untilTs, cleared_at: '' } })
    const stopped = await execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK })
    assert.equal(stopped.blocked, true, JSON.stringify(stopped))
    assert.match(String(stopped.hint), /停损/)
    assert.equal(spawns.length, before, '停损时不跑书源门')
    assert.ok(readLedger().events.some(e => e.code === 'skipped:stop-loss'), '停损事件留痕')
    /* ④ 批起闸（§9.5 停批次）：停损未停满时，手动开后后台轮直接被拒（不 spawn） */
    const started = await request('/pet/start', { mode: 'background' })
    assert.equal(started.body.started, false, JSON.stringify(started.body))
    assert.match(String(started.body.error), /停损/)
    assert.equal(spawns.length, before, '停损时不 spawn 后台进程')
    /* ⑤ /status 暴露边界读数（T7 真机验收靠它核对） */
    const status = (await request('/status')).body
    assert.equal(status.whaleBounds.stop.active, true)
    assert.equal(status.whaleBounds.stop.level, 'L1')
    assert.equal(status.whaleBounds.phase, 'observation')
    assert.equal(status.whaleBounds.cap, 3)
    assert.ok(status.whaleBounds.boundsFile.endsWith('whale-bounds.json'))
  } finally {
    for (const fn of cleanups.reverse()) try { fn() } catch {}
    cp.spawn = originalSpawn; syncBuiltinESMExports(); McpClient.prototype.call = original
    rmSync(dir, { recursive: true, force: true })
  }
})
