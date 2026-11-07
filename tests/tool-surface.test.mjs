import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { McpClient } from '../lib/mcp.mjs'
import { MAIN_ENV_PACKAGES, environmentPython } from '../lib/python-env.mjs'

// The builtin library is resolved when index imports sticker.mjs; isolate before that import.
const surfaceHome = mkdtempSync(join(tmpdir(), 'fish-surface-builtin-'))
const inherited = { sticker: process.env.DAFEIYU_STICKER_DIR, role: process.env.BILI_DUTY_ROLE, home: process.env.BILI_DUTY_HOME }
process.env.DAFEIYU_STICKER_DIR = surfaceHome
delete process.env.BILI_DUTY_ROLE; delete process.env.BILI_DUTY_HOME
test.after(() => {
  for (const [key, value] of [['DAFEIYU_STICKER_DIR', inherited.sticker], ['BILI_DUTY_ROLE', inherited.role], ['BILI_DUTY_HOME', inherited.home]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
  rmSync(surfaceHome, { recursive: true, force: true })
})
const { apply } = await import('../index.js')

const BV = 'BV1234567890', SEEN = 'BV1234567891', FRESH = 'BV1234567892'
const UID = '1234567890123456789', RPID = '2345678901234567890', ROOT = '3456789012345678901', OPUS = '4567890123456789012', SEQ = '5678901234567890123', SENT = '6789012345678901234'
const TEXT = '镜头停在倒影上的那几秒，水面和光线的变化特别清楚。'
const NL = String.fromCharCode(10)
const HOOK = '讲复利那三分钟本鱼来回听了三遍，数字一减就懂了，嘿嘿。'
const GATE_BLOCK = '鲸鱼整理的《合成的书名》资源包：https://pan.quark.cn/s/synthetic 提取码：sx12'
const GATE_FOUND = { ok: true, found: true, source: 'ledger', bookId: 'synthetic-book', bookTitle: '合成的书名', disk: 'quark', block: GATE_BLOCK, blockLen: [...GATE_BLOCK].length, fromLedger: true }
const immediate = () => new Promise(resolve => setImmediate(resolve))
const successfulContracts = new Set()

/** Executable 40-tool inventory. Every entry runs successfully below and is fenced in ordinary mode.
 * The specialist suites additionally prove the deeper lifecycle/policy named in the final column.
 * New registration without a real contract fails the exact inventory assertion.
 */
export const TOOL_SURFACE_EVIDENCE = Object.freeze({
  bili_whoami: [{}, 'readonly', 'login.test.mjs'],
  bili_search: [{ keyword: '合成搜索', num: 80, days: 900, order: 'pubdate' }, 'readonly', 'manual-browsing.test.mjs'],
  bili_subtitle: [{ bvid: BV, with_time: false }, 'readonly', 'manual-browsing.test.mjs'],
  bili_danmaku: [{ bvid: BV, num: 900, hot: true }, 'readonly', 'tool-surface.test.mjs'],
  bili_buzzwords: [{}, 'readonly', 'manual-browsing.test.mjs'],
  bili_video_info: [{ bvid: BV }, 'readonly', 'tool-surface.test.mjs'],
  bili_rank: [{ category: 'knowledge', day: 7 }, 'readonly', 'manual-browsing.test.mjs'],
  bili_hot_videos: [{ pn: 3, ps: 80 }, 'readonly', 'manual-browsing.test.mjs'],
  bili_user_videos: [{ uid: UID, pn: 7, ps: 12, order: 'click', keyword: '合成投稿' }, 'readonly', 'tool-surface.test.mjs'],
  bili_seen: [{ action: 'mark', bvid: BV, note: '合成的已读理由' }, 'local', 'memory-chain.test.mjs'],
  bili_received_replies: [{}, 'readonly', 'reply.test.mjs'],
  bili_my_notices: [{ num: 100 }, 'readonly', 'memory-chain.test.mjs'],
  bili_learn: [{ action: 'add', kind: 'style', text: '先指出具体细节，再表达自己的判断。', from: 'fixture:surface' }, 'local', 'memory-center-routes.test.mjs'],
  bili_records: [{ type: 'activity', num: 3 }, 'local', 'memory-chain.test.mjs'],
  bili_soul: [{ action: 'append', section: 'mood', text: '刚读到的光线细节让我有点好奇。' }, 'local', 'memory-center-routes.test.mjs'],
  bili_taste: [{ action: 'digest' }, 'local', 'memory-chain.test.mjs'],
  bili_my_dynamics: [{ num: 100 }, 'readonly', 'tool-surface.test.mjs'],
  bili_opus_comments: [{ opus_id: OPUS, num: 100 }, 'readonly', 'dup-cross-channel.test.mjs'],
  bili_my_video_comments: [{ num: 100, videos: 100 }, 'readonly', 'reply.test.mjs'],
  bili_reply_opus: [{ opus_id: OPUS, rpid: RPID, root: ROOT, text: TEXT }, 'send', 'send-review-routes.test.mjs'],
  bili_dm_inbox: [{ num: 100 }, 'readonly', 'background-tools.test.mjs'],
  bili_dm_thread: [{ uid: UID, num: 100 }, 'readonly', 'manual-browsing.test.mjs'],
  bili_dm_reply: [{ uid: UID, msg_seqno: SEQ, text: TEXT }, 'send', 'background-tools.test.mjs'],
  bili_deliver: [{ text: `倒影片段的光线变化很清楚：https://www.bilibili.com/video/${BV}` }, 'send', 'send-review-routes.test.mjs'],
  bili_comments: [{ bvid: BV, num: 12 }, 'readonly', 'sticker-routes.test.mjs'],
  bili_sticker: [{ action: 'list' }, 'local', 'sticker-review-routes.test.mjs'],
  bili_reply: [{ bvid: BV, text: TEXT, picture: '' }, 'send', 'send-review-routes.test.mjs'],
  bili_comment: [{ bvid: BV, text: TEXT, picture: '' }, 'send', 'send-review-routes.test.mjs'],
  bili_book_comment: [{ bvid: BV, title: '合成的书名', hook: HOOK, picture: '' }, 'send', 'book-comment.test.mjs'],
  bili_status: [{}, 'local', 'product-status-routes.test.mjs'],
  bili_pace: [{ kind: 'reply' }, 'local', 'pace-routes.test.mjs'],
  bili_say: [{ text: '这次合成片段的倒影细节值得保留。', bvid: BV }, 'local', 'manual-browsing.test.mjs'],
  bili_run: [{}, 'worker', 'pet-run-routes.test.mjs'],
  bili_feiyu: [{ action: 'start', objective: '只分析本地合成数据，不访问真实账号。', maxRounds: 2 }, 'goal', 'pet-run-routes.test.mjs'],
  bili_pv: [{ action: 'list' }, 'local', 'pv-session-routes.test.mjs'],
  bili_moment: [{ text: TEXT }, 'send', 'send-review-routes.test.mjs'],
  bili_login_start: [{}, 'login', 'login.test.mjs'],
  bili_login_poll: [{ key: 'surface-qr-key' }, 'login', 'login.test.mjs'],
  bili_setup: [{}, 'installer', 'install-routes.test.mjs'],
  bili_config: [{ patch: { focus: '合成的内容偏好' } }, 'local', 'authorization.test.mjs'],
})

const readContracts = {
  bili_whoami: ['bili_check_credential', {}, out => { assert.equal(out.ok, true); assert.equal(out.mid, UID); assert.equal(out.name, '合成账号') }],
  bili_search: ['bili_search', { keyword: '合成搜索', num: 50, days: 365, order: 'pubdate' }, discovery],
  bili_subtitle: ['bili_subtitle', { bvid: BV, with_time: false }, out => assert.equal(out.text, '合成字幕保留原文与时序')],
  bili_danmaku: ['bili_danmaku', { bvid: BV, num: 300 }, out => { assert.equal(out.ok, true); assert.equal(out.total, 4); assert.equal(out.hot[0].at, 10); assert.equal(out.hot[0].count, 3); assert.deepEqual(out.hot[0].samples, ['合成弹幕一', '合成弹幕二', '合成弹幕三']); assert.match(out.hot[0].link, /t=10$/) }],
  bili_buzzwords: ['bili_hot_buzzwords', {}, out => { assert.equal(out.ok, true); assert.equal(out.total, 9); assert.deepEqual(out.words, [{ word: '合成热词', hot: 123, pic: 'https://synthetic.invalid/pic.png' }]) }],
  bili_video_info: ['bili_video_info', { bvid: BV }, out => { assert.equal(out.bvid, BV); assert.equal(out.owner.mid, UID); assert.equal(out.pages[0].cid, ROOT); assert.equal(out.title, '合成的视频详情') }],
  bili_rank: ['bili_rank', { category: 'knowledge', day: 7 }, discovery],
  bili_hot_videos: ['bili_hot_videos', { pn: 3, ps: 50 }, discovery],
  bili_user_videos: ['bili_user_videos', { uid: UID, pn: 7, ps: 12, order: 'click', keyword: '合成投稿' }, discovery],
  bili_received_replies: ['bili_received_replies', {}, out => { assert.equal(out.ok, true); assert.equal(out.items[0].reply_rpid, RPID); assert.equal(out.items[0].root_rpid, ROOT); assert.equal(out.items[0].can_reply, true); assert.equal(out.items[1].can_reply, false) }],
  bili_my_notices: ['bili_my_notices', { num: 30 }, out => { assert.equal(out.ok, true); assert.equal(out.count, 7); assert.equal(out.likes[0].item_id, RPID); assert.equal(out.ats[0].uid, UID) }],
  bili_my_dynamics: ['bili_my_dynamics', { num: 30 }, out => { assert.equal(out.ok, true); assert.equal(out.items[0].opus_id, OPUS); assert.equal(out.withComments, 1) }],
  bili_opus_comments: ['bili_opus_comments', { opus_id: OPUS, num: 30 }, out => { assert.equal(out.ok, true); assert.equal(out.opus_id, OPUS); assert.equal(out.items[0].rpid, RPID); assert.equal(out.items[0].root, ROOT); assert.equal(out.items[0].can_reply, true) }],
  bili_my_video_comments: ['bili_my_video_comments', { num: 30, videos: 10 }, out => { assert.equal(out.ok, true); assert.equal(out.items[0].rpid, RPID); assert.equal(out.items[0].root, ROOT); assert.equal(out.items[0].can_reply, true); assert.equal(out.items[1].can_reply, false) }],
  bili_dm_inbox: ['bili_dm_list', { num: 30 }, out => { assert.equal(out.ok, true); assert.equal(out.items[0].uid, UID); assert.equal(out.items[0].msg_seqno, SEQ); assert.equal(out.items[0].can_reply, true); assert.equal(out.items[1].can_reply, false) }],
  bili_dm_thread: ['bili_dm_thread', { talker_id: UID, num: 50 }, out => { assert.equal(out.ok, true); assert.equal(out.messages[0].sender_uid, UID); assert.equal(out.messages[0].msg_seqno, SEQ) }],
  bili_comments: ['bili_comments', { bvid: BV, num: 12 }, out => { assert.equal(out.comments[0].rpid, RPID); assert.equal(out.comments[0].member.mid, UID); assert.equal(out.comments[0].content, '合成评论里的倒影很好看。') }],
}

function discovery(out) {
  assert.equal(out.videos.length, 4)
  assert.equal(out.videos.find(row => row.bvid === SEEN).already_seen, true)
  assert.deepEqual(out.fresh.map(row => row.bvid), [FRESH, BV])
  assert.equal(out.seen_summary.fresh, 2)
}

const sourceReply = name => {
  if (['bili_search', 'bili_rank', 'bili_hot_videos', 'bili_user_videos'].includes(name)) return { videos: [{ bvid: SEEN, play: 999 }, { bvid: BV, play: 30 }, { bvid: FRESH, play: 70 }, { bvid: FRESH, play: 70 }] }
  if (name === 'bili_guard_status') return { ok: true, seenVideos: { [SEEN]: { at: '2026-10-29', title: '合成永久已读' } } }
  if (name === 'bili_check_credential') return { mid: UID, name: '合成账号', valid: true }
  if (name === 'bili_subtitle') return { text: '合成字幕保留原文与时序', segments: 1, segments_detail: [{ from: 0.1, to: 1.2, content: '合成字幕保留原文与时序' }] }
  if (name === 'bili_danmaku') return { danmakus: [{ time: 11, text: '合成弹幕一' }, { time: 12, text: '合成弹幕二' }, { time: 19.9, text: '合成弹幕三' }, { time: 80, text: '合成弹幕四' }] }
  if (name === 'bili_hot_buzzwords') return { buzzwords: [{ name: '合成热词', hot_value: 123, picture: 'https://synthetic.invalid/pic.png' }], page: { total: 9 } }
  if (name === 'bili_video_info') return { bvid: BV, aid: ROOT, title: '合成的视频详情', owner: { mid: UID }, pages: [{ cid: ROOT, page: 1 }] }
  if (name === 'bili_received_replies') return { items: [{ reply_rpid: RPID, root_rpid: ROOT, bvid: BV }, { reply_rpid: Number(RPID), root_rpid: ROOT, bvid: BV }] }
  if (name === 'bili_my_notices') return { count: 7, likes: [{ item_id: RPID, count: 7 }], ats: [{ uid: UID, text: '合成通知' }] }
  if (name === 'bili_my_dynamics') return { items: [{ opus_id: OPUS, has_comments: true, comments: 2 }] }
  if (name === 'bili_opus_comments') return { items: [{ rpid: RPID, root: ROOT, is_me: false }] }
  if (name === 'bili_my_video_comments') return { items: [{ bvid: BV, rpid: RPID, root: ROOT }, { bvid: BV, rpid: RPID, root: ROOT, is_me: true }] }
  if (name === 'bili_dm_list') return { items: [{ uid: UID, msg_seqno: SEQ, is_follow: true, days_ago: 0, said: '合成私信，仅在受控内存中使用' }, { uid: Number(UID), msg_seqno: SEQ, is_follow: true, days_ago: 0 }] }
  if (name === 'bili_dm_thread') return { messages: [{ sender_uid: UID, msg_seqno: SEQ, text: '合成私信记录' }] }
  if (name === 'bili_comments') return { comments: [{ rpid: RPID, member: { mid: UID }, content: '合成评论里的倒影很好看。' }] }
  if (['bili_reply', 'bili_reply_opus', 'bili_send_message', 'bili_send_dynamic'].includes(name)) return { success: true, rpid_str: SENT, dynamic_id: OPUS }
  throw new Error('UNEXPECTED_DOWNSTREAM_TOOL: ' + name)
}

async function fixture(run, { permissions = false, worker = false, login = false, installer = false, gate = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fish-tool-surface-')), home = join(root, 'bili-duty'), cleanups = [], tools = new Map(), events = new Map(), calls = [], subprocesses = [], fetches = [], goals = new Map()
  mkdirSync(home)
  const cli = join(root, 'synthetic-cli.js'); writeFileSync(cli, '// Never executed; child process is mocked.')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ learnAutoReview: false, reportLevel: 'off', pythonPath: 'synthetic-python', dshBin: cli,
    backgroundModelId: 'surface/model', autoComment: permissions, replyToComments: permissions, autoReplyDm: permissions, autoMoment: permissions,
    momentPerDay: 3, dmReplyFollowedOnly: false, dmMode: permissions ? 'both' : 'off', dmUid: UID, sendReview: false, stickerAutoCollect: false, stickerAutoSend: false }))
  writeFileSync(join(home, 'bili_credential.json'), JSON.stringify({ sessdata: 'synthetic-session', bili_jct: 'synthetic-csrf' }))
  const fish = { id: 'surface-fish', status: 'idle', session: { id: 'surface-fish', header: { agentPreset: 'dafeiyu', cwd: root } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => { if (tools.get(spec.name) === spec) tools.delete(spec.name) } } } }, cancel() {} }
  const normal = { id: 'surface-normal', session: { header: { agentPreset: 'standard', cwd: root } }, ctx: { tools: { register() { assert.fail('ordinary session cannot mount fish schemas') } } } }
  let handler, child
  const goalService = { get: agent => goals.get(agent.id), create(agent, spec) { const value = { id: 'surface-goal', objective: spec.objective, maxGoalRounds: spec.maxGoalRounds, roundsStarted: 1, revision: 1, phase: 'active', activation: 'armed' }; goals.set(agent.id, value); return value },
    pause(agent) { const value = goals.get(agent.id); value.phase = 'paused'; value.activation = 'disarmed'; return value }, resume(agent) { const value = goals.get(agent.id); value.phase = 'active'; value.activation = 'armed'; return value }, clear(agent) { const value = goals.get(agent.id); goals.delete(agent.id); return value } }
  const ctx = { logger: { info() {} }, settings: { describe: () => [] }, tools: { register() { assert.fail('global registration forbidden') } },
    get: key => key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [fish, normal] } : key === 'goals' ? goalService : key === 'llm' ? { listProviders: () => [{ id: 'surface' }] } : undefined,
    on(name, fn) { const rows = events.get(name) || []; rows.push(fn); events.set(name, rows); return () => events.set(name, rows.filter(row => row !== fn)) },
    effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) }, webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  const cp = createRequire(import.meta.url)('node:child_process'), original = { spawn: cp.spawn, call: McpClient.prototype.call, fetch: globalThis.fetch }
  McpClient.prototype.call = async function(name, args) { calls.push({ name, args: structuredClone(args) }); return sourceReply(name) }
  cp.spawn = (command, args, options) => {
    // Do not retain inherited process.env or unrelated user secrets in assertion output.
    subprocesses.push({ command, args, cwd: options?.cwd, shell: options?.shell })
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('close', null)); return true }; child.unref = () => {}
    const current = child
    if (worker && args.includes(cli)) return current
    if (login && args[0] === '-c' && args.at(-1).endsWith('.png')) {
      queueMicrotask(() => { writeFileSync(args.at(-1), 'synthetic-QR-bytes'); current.emit('exit', 0) }); return current
    }
    if (installer) {
      queueMicrotask(() => {
        if (args[0] === 'venv' || args[0] === 'pip') {
          const venv = join(home, '.venv'), py = environmentPython(venv)
          mkdirSync(dirname(py), { recursive: true }); writeFileSync(py, 'synthetic-python-bytes'); writeFileSync(join(venv, 'pyvenv.cfg'), 'version = 3.12.10\n')
          const site = process.platform === 'win32' ? join(venv, 'Lib', 'site-packages') : join(venv, 'lib', 'python3.12', 'site-packages')
          for (const name of MAIN_ENV_PACKAGES) mkdirSync(join(site, name), { recursive: true })
          writeFileSync(join(site, 'PIL', '_version.py'), '__version__ = "13.0.0"\n')
        }
        current.emit('exit', 0)
      }); return current
    }
    if (gate && String(args?.[0] ?? '').endsWith('client.py')) {
      queueMicrotask(() => { current.stdout.emit('data', Buffer.from(JSON.stringify(gate))); current.emit('close', 0) }); return current
    }
    throw new Error('UNEXPECTED_SUBPROCESS_IN_SURFACE_FIXTURE')
  }; syncBuiltinESMExports()
  globalThis.fetch = async url => {
    fetches.push(String(url))
    assert.equal(login, true, 'all account/network transports must be mocked deliberately')
    assert.ok(String(url).startsWith('https://passport.bilibili.com/'))
    if (String(url).includes('/generate')) return { json: async () => ({ data: { qrcode_key: 'surface-qr-key', url: 'https://synthetic.invalid/qr' } }) }
    return { json: async () => ({ data: { code: 0 } }), headers: { getSetCookie: () => ['SESSDATA=synthetic-new-session; HttpOnly', 'bili_jct=synthetic-new-csrf; HttpOnly', 'buvid3=synthetic-device; Path=/'] } }
  }
  const execute = async (name, args = TOOL_SURFACE_EVIDENCE[name][0], agent = fish) => {
    const out = await tools.get(name).execute(structuredClone(args), { agent })
    if (agent === fish && out && out.ok !== false && !out.blocked && !out.error && !out.review_required) successfulContracts.add(name)
    return out
  }
  const request = async (path, body) => {
    const req = new EventEmitter(); Object.assign(req, { method: body === undefined ? 'GET' : 'POST', url: '/api/bili-duty' + path, headers: {} })
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = JSON.parse(value) } }
    const pending = handler(req, res); if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }; await pending; return res
  }
  try {
    apply(ctx, {}); await immediate()
    assert.deepEqual([...tools.keys()].sort(), Object.keys(TOOL_SURFACE_EVIDENCE).sort()); assert.equal(tools.size, 40)
    await run({ root, home, fish, normal, goals, tools, calls, subprocesses, fetches, execute, request, child: () => child, async select(preset) { fish.session.header.agentPreset = preset; for (const fn of events.get('agent-preset/selected') || []) await fn(fish.id, preset); await immediate() } })
    if (!worker && !login && !installer && !gate) assert.deepEqual(subprocesses, [], 'read/local/send fixture must not run Python or any subprocess')
    if (!login) assert.deepEqual(fetches, [], 'MCP fixtures must not call a network endpoint')
  } finally {
    for (const off of cleanups.reverse()) try { await off() } catch {}
    cp.spawn = original.spawn; McpClient.prototype.call = original.call; globalThis.fetch = original.fetch; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true })
  }
}

test('all 17 account read tools route meaningful inputs to the right MCP names, retain long IDs and preserve returned data', async () => fixture(async f => {
  // Subtitle success deliberately marks BV read; exercise discovery first, then prove that write.
  const entries = [...Object.entries(readContracts).filter(([name]) => name !== 'bili_subtitle'), ['bili_subtitle', readContracts.bili_subtitle]]
  for (const [name, [downstream, args, check]] of entries) {
    const before = f.calls.length, out = await f.execute(name)
    assert.deepEqual(f.calls[before], { name: downstream, args }, name)
    check(out)
    const extra = f.calls.slice(before + 1)
    assert.ok(extra.every(row => row.name === 'bili_guard_status'), name + ' must not silently call another account action')
    if (['bili_search', 'bili_rank', 'bili_hot_videos', 'bili_user_videos'].includes(name)) assert.deepEqual(extra[0].args, { bvids: [SEEN, BV, FRESH], limit: 3 })
  }
}))

test('UID/opus read inputs reject already-rounded numbers before account IO', async () => fixture(async f => {
  for (const [name, args] of [['bili_user_videos', { uid: Number(UID) }], ['bili_dm_thread', { uid: Number(UID) }], ['bili_opus_comments', { opus_id: Number(OPUS) }]]) {
    await assert.rejects(f.execute(name, args), /safe integer/, name)
  }
  assert.deepEqual(f.calls, [])
}))

test('local memory, ledgers, content preferences, status and video listing execute positive contracts without account IO', async () => fixture(async f => {
  assert.equal((await f.execute('bili_seen')).marked, 1)
  assert.equal((await f.execute('bili_seen', { action: 'check', bvid: BV })).already_seen, true)
  const learned = await f.execute('bili_learn'); assert.equal(learned.ok, true); assert.equal(learned.added, true); assert.ok(learned.id)
  assert.equal((await f.execute('bili_learn', { action: 'approve', id: learned.id })).review_required, true)
  assert.equal((await f.execute('bili_soul')).ok, true)
  assert.match((await f.execute('bili_soul', { action: 'read' })).text, /光线细节/)
  const taste = await f.execute('bili_taste'); assert.equal(taste.ok, true); assert.equal(taste.enough, false)
  const said = await f.execute('bili_say'); assert.equal(said.ok, true); assert.equal(said.bvid, BV); assert.ok(said.uid)
  const records = await f.execute('bili_records'); assert.equal(records.ok, true); assert.ok(records.items.length > 0); assert.ok(records.items.every(row => row.eventId))
  const stickers = await f.execute('bili_sticker'); assert.equal(stickers.ok, true); assert.ok(Array.isArray(stickers.stickers))
  const status = await f.execute('bili_status'); assert.equal(status.ok, true); assert.equal(status.loggedIn, true); assert.equal(status.autoComment, false)
  const pace = await f.execute('bili_pace'); assert.equal(pace.ok, true); assert.deepEqual(Object.keys(pace.kinds), ['reply'])
  const config = await f.execute('bili_config'); assert.equal(config.ok, true); assert.equal(config.config.focus, '合成的内容偏好'); assert.equal(config.config.autoComment, false)
  const pv = await f.execute('bili_pv'); assert.equal(pv.ok, true); assert.deepEqual(pv.videos, []); assert.deepEqual(pv.productions, []); assert.deepEqual(pv.sessions, [])
  assert.deepEqual(f.calls, [])
}))

const downstreamSend = { bili_reply: 'bili_reply', bili_comment: 'bili_reply', bili_reply_opus: 'bili_reply_opus', bili_dm_reply: 'bili_send_message', bili_deliver: 'bili_send_message', bili_moment: 'bili_send_dynamic' }
for (const [name, downstream] of Object.entries(downstreamSend)) test(`${name} succeeds through its real wrapper with controlled sending and retains exact target IDs`, async () => fixture(async f => {
  const out = await f.execute(name)
  if (name === 'bili_reply' || name === 'bili_comment') assert.equal(out.success, true, JSON.stringify(out))
  else assert.equal(out.ok, true, JSON.stringify(out))
  const sent = f.calls.find(row => row.name === downstream); assert.ok(sent, name + ' must perform its intended controlled MCP send')
  assert.equal(sent.args.text, TOOL_SURFACE_EVIDENCE[name][0].text)
  if (name === 'bili_reply' || name === 'bili_comment') assert.equal(sent.args.bvid, BV)
  if (name === 'bili_comment') assert.equal(sent.args.rpid, '0', 'bili_comment must never become a floor reply')
  if (name === 'bili_reply_opus') assert.deepEqual(sent.args, { opus_id: OPUS, rpid: RPID, root: ROOT, text: TEXT })
  if (name === 'bili_dm_reply' || name === 'bili_deliver') assert.equal(sent.args.receiver_uid, UID)
  if (name === 'bili_dm_reply') assert.equal(sent.args.msg_seqno, SEQ)
}, { permissions: true }))

test('every sending wrapper refuses valid content with disabled permissions and performs zero account IO', async () => fixture(async f => {
  for (const name of [...Object.keys(downstreamSend), 'bili_book_comment']) assert.equal((await f.execute(name)).blocked, true, name)
  assert.deepEqual(f.calls, [])
}))

test('recipient config and status preserve large UID strings; unsafe numeric PATCHes fail without changing the saved recipient', async () => fixture(async f => {
  const saved = await f.request('/config', { dmUid: '000' + UID, dmMode: 'both' })
  assert.equal(saved.status, 200); assert.equal(saved.body.config.dmUid, UID)
  assert.equal((await f.execute('bili_status')).dmUid, UID)
  assert.equal((await f.request('/config')).body.config.dmUid, UID)
  const file = join(f.home, 'config.json'), before = readFileSync(file, 'utf8')
  for (const dmUid of [Number(UID), -1, 1.2, null, {}, false, '1e19']) {
    const rejected = await f.request('/config', { dmUid })
    assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'CONFIG_UID_INVALID')
    assert.equal(readFileSync(file, 'utf8'), before)
  }
  assert.equal((await f.request('/config', { dmUid: 123 })).body.config.dmUid, 123)
  assert.equal((await f.request('/config', { dmUid: '' })).body.config.dmUid, 0)
  assert.deepEqual(f.calls, [])
}))

test('bili_feiyu starts, pauses, resumes and clears only its own controlled goal', async () => fixture(async f => {
  const started = await f.execute('bili_feiyu'); assert.equal(started.ok, true); assert.equal(started.started, true); assert.equal(started.maxRounds, 2)
  assert.match(f.goals.get(f.fish.id).objective, /只分析本地合成数据/)
  assert.equal((await f.execute('bili_feiyu', { action: 'status' })).active, true)
  assert.equal((await f.execute('bili_feiyu', { action: 'stop' })).paused, true)
  assert.equal((await f.execute('bili_feiyu', { action: 'resume' })).ok, true)
  assert.equal((await f.execute('bili_feiyu', { action: 'clear' })).ok, true)
  assert.equal(f.goals.size, 0); assert.deepEqual(f.calls, [])
}))

test('bili_run starts and finishes a controlled worker rather than reporting a failed start as success', async () => fixture(async f => {
  const out = await f.execute('bili_run'); assert.equal(out.ok, true); assert.equal(out.started, true)
  assert.equal(f.subprocesses.length, 1); f.child().emit('close', 0)
  assert.equal((await f.request('/status')).body.backgroundRun.active, false)
  assert.deepEqual(f.calls, [])
}, { worker: true }))

test('login tool wrappers create a synthetic QR and persist only their own completed generation', async () => fixture(async f => {
  const qr = await f.execute('bili_login_start'); assert.equal(qr.ok, true); assert.equal(qr.key, 'surface-qr-key'); assert.ok(existsSync(qr.png))
  const polled = await f.execute('bili_login_poll'); assert.equal(polled.ok, true); assert.equal(polled.state, 'ok')
  assert.doesNotMatch(JSON.stringify(polled), /synthetic-new-session|synthetic-new-csrf/)
  assert.equal(JSON.parse(readFileSync(join(f.home, 'bili_credential.json'), 'utf8')).sessdata, 'synthetic-new-session')
  assert.equal(f.fetches.length, 2); assert.deepEqual(f.calls, [])
}, { login: true }))

test('bili_setup executes the actual installer to completion using only mocked process and package outputs', async () => fixture(async f => {
  const start = await f.execute('bili_setup'); assert.equal(start.ok, true); assert.equal(start.started, true)
  for (let n = 0; n < 100; n++) {
    await immediate(); const status = (await f.request('/status')).body
    if (!status.installing) { assert.equal(status.venvReady, true); assert.equal(status.environment.pillowVersion, '13.0.0'); return }
  }
  assert.fail('the controlled setup tool did not finish')
}, { installer: true }))

test('all 40 ordinary-session and post-exit stale handles fail mode_required before account, network or process IO', async () => fixture(async f => {
  const handles = new Map(f.tools)
  for (const [name, spec] of handles) {
    const out = await spec.execute(structuredClone(TOOL_SURFACE_EVIDENCE[name][0]), { agent: f.normal })
    assert.equal(out.reason, 'mode_required', name); assert.equal(out.blocked, true, name)
  }
  await f.select('standard'); assert.equal(f.tools.size, 0)
  for (const [name, spec] of handles) assert.equal((await spec.execute(structuredClone(TOOL_SURFACE_EVIDENCE[name][0]), { agent: f.fish })).reason, 'mode_required', name)
  assert.deepEqual(f.calls, []); assert.deepEqual(f.fetches, []); assert.deepEqual(f.subprocesses, [])
}))

test('bili_book_comment composes hook+block through the gate and sends through the shared chain', async () => fixture(async f => {
  const out = await f.execute('bili_book_comment', { bvid: BV, title: '合成的书名', hook: HOOK, picture: '' })
  assert.equal(out.success, true, JSON.stringify(out))
  assert.equal(out.book_comment.found, true)
  assert.equal(out.book_comment.source, 'ledger')
  assert.equal(out.book_comment.bookId, 'synthetic-book')
  assert.equal(out.book_comment.sent, true)
  assert.ok(!JSON.stringify(out).includes('pan.quark'), 'model-facing result must not contain the block')
  assert.ok(f.calls.some(row => row.name === 'bili_video_info'), 'UP uid is fetched before the gate')
  const sent = f.calls.find(row => row.name === 'bili_reply')
  assert.equal(sent.args.rpid, '0', 'book review is always a fresh comment')
  assert.equal(sent.args.text, HOOK + NL + GATE_BLOCK)
  const st = existsSync(join(f.home, 'state.json')) ? JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')) : {}
  assert.ok(st.repliedComments['nu:' + BV], 'nu: key written by the shared chain')
  assert.ok(st.repliedComments['book:synthetic-book'], 'book: key written after success')
  assert.equal(st.repliedComments['book:synthetic-book'].bvid, BV)
  assert.ok(st.repliedComments['up:' + UID], 'up: key written after success')
  assert.equal(st.repliedComments['up:' + UID].uid, UID)
}, { permissions: true, gate: GATE_FOUND }))

test('bili_book_comment gate-miss sends nothing and writes no dedup key', async () => fixture(async f => {
  const out = await f.execute('bili_book_comment', { bvid: BV, title: '没资源的书', hook: HOOK })
  assert.equal(out.ok, false)
  assert.equal(out.blocked, true)
  assert.equal(out.code, 'gate-miss')
  assert.ok(!f.calls.some(row => row.name === 'bili_reply'), 'miss must not send')
  const st = existsSync(join(f.home, 'state.json')) ? JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')) : {}
  const keys = Object.keys(st.repliedComments || {})
  assert.ok(!keys.some(key => key.startsWith('book:') || key.startsWith('up:') || key === 'nu:' + BV), 'miss writes no dedup key (spec §5.2 step 3)')
}, { permissions: true, gate: { ok: true, found: false } }))

test('the 40-item evidence matrix references existing portable specialist suites', () => {
  assert.equal(Object.keys(TOOL_SURFACE_EVIDENCE).length, 40)
  assert.deepEqual([...successfulContracts].sort(), Object.keys(TOOL_SURFACE_EVIDENCE).sort(), 'every registered tool must have completed a positive contract, not merely an invalid-input refusal')
  for (const [name, [args, category, file]] of Object.entries(TOOL_SURFACE_EVIDENCE)) {
    assert.ok(args && typeof args === 'object' && !Array.isArray(args), name)
    assert.ok(['readonly', 'local', 'send', 'worker', 'goal', 'login', 'installer'].includes(category), name)
    assert.ok(existsSync(new URL(file, import.meta.url)), name + ': ' + file)
  }
})
