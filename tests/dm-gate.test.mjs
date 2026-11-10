/**
 * T4 单测：求资源私信的书源门注入 / 字数口径 / 工具描述 / dm 台账 / dry-run（规格 #1751 B/C/G）。
 *
 * 缝：**工具面**（现有 fake relay + 假下游，不引入新 seam）。
 *   · `McpClient.prototype.call` 拦住 bili_dm_list / bili_send_message；
 *   · `callBookGate` 的 spawnFn 走不了（宿主内部拼 client.py 路径）⇒ 用**假 client.py 脚本**
 *     注入 `pythonPath` 指向 node 包装：既过真链路（spawn → stdout JSON），又零网络。
 *
 * ⚠️ 测试里出现的「链接」一律是夹具口令块（与 tools/book-gate/fixtures 同族），
 *    不是生产台账里的真链（规格 C 段：测试不出现真实链接）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'
import { emptyDmLedger } from '../lib/dm-ledger.mjs'

const root = mkdtempSync(join(tmpdir(), 'fish-dm-gate-'))
let sequence = 0
const flush = () => new Promise(resolve => setImmediate(resolve))

/** 夹具口令块（与 tools/book-gate/fixtures/blocks.json 同口径，逐字） */
const QUARK_BLOCK = '小岛经济学\nhttps://pan.quark.cn/s/60fc0b3c0f8d\n提取码：22EM'
const BAIDU_BLOCK = '通过百度网盘分享的文件：杀死一只知更鸟\n链接:https://pan.baidu.com/s/1TKxndMvHX7PRrO05zFR7yw\n提取码:ktiy\n复制这段内容打开「百度网盘APP 即可获取」'

/** 假书源门：一个 node 脚本，按 argv[2] 的 JSON 请求回固定/可编排的响应。 */
function writeFakeGate(dir, responses) {
  const script = join(dir, 'fake-gate.mjs')
  writeFileSync(script, `
    const responses = ${JSON.stringify(responses)}
    const req = JSON.parse(process.argv[2] || '{}')
    const key = req.title
    const r = responses[key] || { ok: true, found: false }
    process.stdout.write(JSON.stringify(r))
  `)
  return script
}

async function fixture(extra = {}) {
  const dir = join(root, String(++sequence)), home = join(dir, 'bili-duty')
  mkdirSync(home, { recursive: true })
  const gateScript = writeFakeGate(dir, {
    '小岛经济学': { ok: true, found: true, source: 'ledger', bookId: '小岛经济学', disk: 'quark', block: QUARK_BLOCK, blockLen: Array.from(QUARK_BLOCK).length, fromLedger: true, jobId: null, candidateId: null },
    '杀死一只知更鸟': { ok: true, found: true, source: 'netdisk', bookId: '杀死一只知更鸟', disk: 'baidu', block: BAIDU_BLOCK, blockLen: Array.from(BAIDU_BLOCK).length, fromLedger: false, jobId: 'j-1', candidateId: 'c-1' },
    '不存在的书': { ok: true, found: false },
    '门炸了': { ok: false, code: 'gate-timeout', detail: '书源门调用超时（不重试）' },
  })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: false, autoComment: false, replyToComments: true,
    autoReplyDm: true, dmReplyFollowedOnly: false, learnAutoReview: false, reportLevel: 'off',
    pythonPath: process.execPath, bookGateClient: gateScript, ...extra }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ unrelated: 61, tokensTotal: 0 }))
  const cleanups = [], tools = new Map(), calls = []
  const agent = { id: 'gate-fish-' + sequence, session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  let handler
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name, args) {
    calls.push({ name, args })
    if (name === 'bili_dm_list') {
      // 收件箱复核（闸门四）会拿 seqno 回这里找 ⇒ 每条要回的 seqno 都必须在列表里
      return { items: [
        { uid: '123', msg_seqno: '456', is_follow: true, days_ago: 0, said: '有《小岛经济学》吗', timestamp: Math.floor(Date.now() / 1000) },
        { uid: '123', msg_seqno: '789', is_follow: true, days_ago: 0, said: '那《杀死一只知更鸟》有吗', timestamp: Math.floor(Date.now() / 1000) },
      ] }
    }
    if (name === 'bili_send_message') return { success: true, msg_key: '7706211630523724682' }
    return { success: true }
  }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  apply(ctx, {}); await flush()
  const execute = (name, args, exec = { agent }) => tools.get(name).execute(args, exec)
  const dmLedger = () => {
    const p = join(home, 'whale-dm', 'ledger.json')
    try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return emptyDmLedger() }
  }
  return { dir, home, agent, calls, tools, execute, dmLedger, gateScript,
    close() { for (const fn of cleanups.reverse()) try { fn() } catch {}; McpClient.prototype.call = original } }
}
test.after(() => rmSync(root, { recursive: true, force: true }))

const dmReply = (extra = {}) => ({ uid: '123', msg_seqno: '456', text: '有呀，这本给你——', ...extra })

test('a resource DM gets the verbatim passcode block appended and the model never sees a link field', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_reply', dmReply({ book_title: '小岛经济学' }))
    assert.equal(out.ok, true)
    assert.equal(out.success, true)
    const sent = f.calls.find((c) => c.name === 'bili_send_message')
    assert.ok(sent, 'bili_send_message 必须被调用')
    // ① 块逐字注入：模型 text 一个字不改，块原样拼在后面
    assert.equal(sent.args.text, '有呀，这本给你——\n' + QUARK_BLOCK)
    // ② 回执只给结构字段与长度，**没有链接/提取码字段**
    assert.equal(out.blockLen, Array.from(QUARK_BLOCK).length)
    assert.equal(out.bookId, '小岛经济学')
    assert.equal(out.gateSource, 'ledger')
    assert.equal(out.textLen, Array.from(sent.args.text).length)
    assert.equal(out.text, undefined)
    assert.equal(out.block, undefined)
    assert.equal(out.link, undefined)
    assert.equal(out.passcode, undefined)
    assert.ok(!JSON.stringify(out).includes('pan.quark.cn'), '回执里不许出现链接文本')
  } finally { f.close() }
})

// ⚠️ 一个 fixture 里连发两条会被节奏闸（dm gap 30s）拦住 —— 那是**正确行为**，
//    所以每条块一个 fixture（ pace 账本随 fixture 新建而空）。
test('the quark budget trims the small talk and keeps the block verbatim', async () => {
  const f = await fixture()
  try {
    // 话术超预算（但仍在 200 字上限内）⇒ 按预算截人话，绝不裁块。
    // ⚠️ 模型给的 text 本身也要 ≤200（更外层的闸），所以这里用 190：夸克块 50 ⇒ 预算 149 ⇒ 要截。
    const out = await f.execute('bili_dm_reply', dmReply({ book_title: '小岛经济学', text: '呀'.repeat(190) }))
    assert.equal(out.ok, true)
    assert.equal(out.trimmed, true)
    const sent = f.calls.find((c) => c.name === 'bili_send_message')
    assert.ok(sent.args.text.endsWith(QUARK_BLOCK), '口令块必须完整在末尾')
    // 149（人话）+ 1（换行）+ 50（块）= 200，正好装满
    assert.equal(Array.from(sent.args.text).length, 200)
    assert.equal(out.textLen, 200)
  } finally { f.close() }
})

test('the baidu block still fits with 97 chars of small talk', async () => {
  const f = await fixture()
  try {
    // 百度块 102 字 ⇒ 人话预算 97
    const out = await f.execute('bili_dm_reply', dmReply({ msg_seqno: '789', book_title: '杀死一只知更鸟', text: '呀'.repeat(190) }))
    assert.equal(out.ok, true)
    assert.equal(out.trimmed, true)
    const sent = f.calls.find((c) => c.name === 'bili_send_message')
    assert.ok(sent.args.text.endsWith(BAIDU_BLOCK))
    assert.equal(Array.from(sent.args.text).length, 200)
  } finally { f.close() }
})

test('a gate miss says "not found" without fabricating an alternative resource', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_reply', dmReply({ book_title: '不存在的书' }))
    assert.equal(out.ok, false)
    assert.equal(out.gateMiss, true)
    assert.match(out.error, /没找到可用资源/)
    assert.match(out.hint, /不要编一本替代的/)
    assert.equal(f.calls.some((c) => c.name === 'bili_send_message'), false, '门 miss 不许发送')
    // 台账记事件（dm-gate-miss），不记 row
    const led = f.dmLedger()
    assert.equal(led.rows.length, 0)
    assert.equal(led.events.length, 1)
    assert.equal(led.events[0].code, 'dm-gate-miss')
  } finally { f.close() }
})

test('a gate failure is fail-closed and never downgrades to a bare link', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_reply', dmReply({ book_title: '门炸了' }))
    assert.equal(out.ok, false)
    assert.match(out.error, /gate-timeout/)
    assert.equal(f.calls.some((c) => c.name === 'bili_send_message'), false)
    assert.equal(f.dmLedger().events[0].code, 'dm-gate-miss')
  } finally { f.close() }
})

test('the dm ledger records structure fields only and never the DM body', async () => {
  const f = await fixture()
  try {
    await f.execute('bili_dm_reply', dmReply({ book_title: '杀死一只知更鸟', text: '呀'.repeat(190) }))
    const led = f.dmLedger()
    assert.equal(led.rows.length, 1)
    const row = led.rows[0]
    assert.equal(row.uid, '123')
    assert.equal(row.msg_seqno, '456')
    assert.equal(row.bookId, '杀死一只知更鸟')
    assert.equal(row.gateSource, 'netdisk')
    assert.equal(row.blockLen, Array.from(BAIDU_BLOCK).length)
    assert.equal(row.textLen, 200)
    assert.equal(row.ok, true)
    assert.ok(row.day && row.at, 'day/at 必须落')
    // 正文与链接都不入账
    assert.ok(!JSON.stringify(led).includes('pan.baidu.com'), '台账不许出现链接')
    assert.ok(!JSON.stringify(led).includes('有呀，这本给你'), '台账不许出现私信正文')
    assert.equal(row.text, undefined)
    assert.equal(row.said, undefined)
  } finally { f.close() }
})

test('dry-run composes and returns the full text but never sends and never books', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_reply', dmReply({ book_title: '小岛经济学', dry_run: true }))
    assert.equal(out.ok, true)
    assert.equal(out.dryRun, true)
    assert.equal(out.text, '有呀，这本给你——\n' + QUARK_BLOCK)
    assert.equal(out.blockLen, Array.from(QUARK_BLOCK).length)
    assert.equal(f.calls.some((c) => c.name === 'bili_send_message'), false, 'dry-run 不许发送')
    // 判重账本不写：再来一次同样的 seqno 还能过（不会变成「已回过」）
    const again = await f.execute('bili_dm_reply', dmReply({ book_title: '小岛经济学' }))
    assert.equal(again.ok, true)
    const st = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'))
    assert.deepEqual(Object.keys(st.dmReplied), ['dm:123:456'])
  } finally { f.close() }
})

test('without book_title the reply stays plain text and skips the gate entirely', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_reply', dmReply())
    assert.equal(out.ok, true)
    assert.equal(out.blockLen, undefined)
    const sent = f.calls.find((c) => c.name === 'bili_send_message')
    assert.equal(sent.args.text, '有呀，这本给你——')
    // 没跑书源门 ⇒ 没有 dm 台账行
    assert.equal(f.dmLedger().rows.length, 0)
  } finally { f.close() }
})

test('the tool description no longer forbids links and explains the gate contract', async () => {
  const f = await fixture()
  try {
    const spec = f.tools.get('bili_dm_reply')
    assert.ok(spec, 'bili_dm_reply 工具必须注册')
    // 工具注册出来的是一份 JSON schema：描述在 description 字段上，参数在 properties 里
    assert.doesNotMatch(spec.description, /别粘链接/, '「别粘链接」必须删掉（它堵死需求 2）')
    assert.match(spec.description, /链接与提取码不许自己写/)
    assert.match(spec.description, /口令块逐字拼进正文/)
    assert.match(spec.description, /绝不裁口令块/)
    const props = spec.parameters.properties
    assert.match(props.text.description, /不要写链接/)
    assert.ok(props.book_title, '必须新增 book_title 参数')
    assert.ok(props.dry_run, '必须新增 dry_run 参数')
  } finally { f.close() }
})

test('the inbox marks resource intent so the model has a title candidate to start from', async () => {
  const f = await fixture()
  try {
    const out = await f.execute('bili_dm_inbox', {})
    assert.equal(out.ok, true)
    const it = out.items[0]
    assert.equal(it.resource_intent.seeking, true)
    assert.deepEqual(it.resource_intent.titles, ['小岛经济学'])
    assert.equal(it.resource_intent.need_ask, false)
    assert.match(out.hint, /resource_intent/)
  } finally { f.close() }
})
