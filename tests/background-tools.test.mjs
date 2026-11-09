import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { apply } from '../index.js'
import { createRelayClient, createRelayAdapter } from '../lib/model-relay-adapter.mjs'
import { RELAY_PROVIDER } from '../lib/model-relay.mjs'
import { McpClient } from '../lib/mcp.mjs'
import { backgroundMcpRequest } from '../lib/background-mcp.mjs'
import { backgroundToolNames, exposeBackgroundTools, toolInputSchema, validateToolArguments } from '../lib/background-tools.mjs'

// No Python, credentials or Bilibili requests: exercise the real parent wrappers via localhost MCP.
test('background MCP shares host activity, pending learning, usage and live automation switches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-tool-bridge-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const cli = join(root, 'mock-cli.js'); writeFileSync(cli, '// child spawn mocked')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: cli, learnAutoReview: false, backgroundModelId: 'buddy/fixture', reportLevel: 'off', replyToComments: true, autoComment: false, autoReplyDm: false }))
  const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn, cleanups = [], registered = new Map()
  const fishAgent = { id: 'scope-fixture', session: { header: { agentPreset: 'dafeiyu', cwd: root } },
    ctx: { tools: { register(spec) { registered.set(spec.name, spec); return () => registered.delete(spec.name) } } } }
  let handler, childEnv, child
  cp.spawn = (command, args, options) => {
    childEnv = options.env
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null
    child.kill = () => true
    return child
  }; syncBuiltinESMExports()
  let streams = 0
  const llm = {
    listProviders: () => [{ id: 'buddy' }],
    resolveModelInfo: async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 8192 } }),
    prepareCall: async config => ({ config, async *stream() {
      yield { type: 'text-delta', index: 0, text: 'fixture reply' }
      if (++streams <= 2) yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 3, cacheReadTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }),
  }
  const ctx = {
    logger: { info() {} },
    get: key => key === 'llm' ? llm : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [fishAgent], get: id => id === fishAgent.id ? fishAgent : undefined } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  async function request(path, body = {}, method = 'POST') {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = method; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res)
    if (method === 'POST') { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await pending; return { statusCode: res.code, ...res.body }
  }
  try {
    apply(ctx, {}); await new Promise(resolve => setImmediate(resolve))
    assert.equal((await request('/pet/start', { mode: 'background' })).started, true)
    const overlay = readFileSync(join(home, 'headless-overlay.yml'), 'utf8')
    assert.match(overlay, /background-mcp\.mjs/); assert.doesNotMatch(overlay, /mcp_server\.py|BILI_DUTY_RELAY_CAPABILITY/)
    const client = createRelayClient(childEnv), list = (await backgroundMcpRequest({ id: 1, method: 'tools/list' }, client)).result.tools
    assert.ok(list.some(x => x.name === 'bili_reply')); assert.ok(list.some(x => x.name === 'bili_learn'))
    for (const name of ['bili_dm_reply', 'bili_moment', 'bili_config', 'bili_run', 'bili_setup', 'bili_comment', 'bili_book_comment']) assert.ok(!list.some(x => x.name === name), name)
    // 📚 2026-11-09 内容范围：非书籍内容入口（热榜/排行/热词）移除；UP 跟新保留
    for (const name of ['bili_rank', 'bili_hot_videos', 'bili_buzzwords']) assert.ok(!list.some(x => x.name === name), name)
    assert.ok(list.some(x => x.name === 'bili_user_videos'))
    assert.ok(list.some(x => x.name === 'bili_followings'), 'followings list is available to the background discovery path')
    assert.ok(!('force' in list.find(x => x.name === 'bili_reply').inputSchema.properties))
    let seq = 1
    const call = async (name, args) => {
      const result = (await backgroundMcpRequest({ id: ++seq, method: 'tools/call', params: { name, arguments: args } }, client)).result
      return { isError: result.isError, ...JSON.parse(result.content[0].text) }
    }
    const say = await call('bili_say', { text: '字幕没有来源，今天先空手。', bvid: null })
    assert.equal(say.ok, true)
    const activity = (await request('/activity', {}, 'GET')).rows
    assert.ok(activity.some(x => x.kind === 'say' && /今天先空手/.test(x.text)))
    const learned = await call('bili_learn', { action: 'add', kind: 'style', text: '先回应一个明确细节，再简短表达自己的感受', from: 'fixture:comment' })
    assert.equal(learned.ok, true)
    const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    assert.equal(state().learn.items[learned.id].state, 'pending')
    const blockedApproval = await call('bili_learn', { action: 'approve', id: learned.id })
    assert.equal(blockedApproval.isError, true)
    assert.equal(state().learn.items[learned.id].state, 'pending')
    assert.equal((await registered.get('bili_soul').execute({ action: 'read' }, {})).reason, 'mode_required')
    assert.equal((await call('bili_reply', { bvid: 'BV1234567890', text: 'fixture', force: true })).isError, true)
    await request('/config', { replyToComments: false })
    const disabled = await call('bili_reply', { bvid: 'BV1234567890', text: 'fixture' })
    assert.equal(disabled.isError, true); assert.match(disabled.error, /BACKGROUND_TOOL_DISABLED/)

    const adapter = createRelayAdapter(childEnv)
    for (let i = 0; i < 3; i++) for await (const _ of adapter.stream({ provider: RELAY_PROVIDER, model: 'buddy/fixture', messages: [] })) {}
    // A state update is async; await an unrelated host request/turn before reading its persisted projection.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(state().tokensTotal, 60)
    assert.equal(state().tokensToday, 60)
    child.stderr.emit('data', Buffer.from('Error ETIMEDOUT text="fixture-private-dm-body" content="fixture-secret-content"\n'))
    child.exitCode = 0; child.emit('close', 0)
    const status = await request('/status', {}, 'GET')
    assert.equal(status.backgroundRun.stopReason, 'exit')
    assert.equal(status.backgroundRun.requests, 3)
    assert.equal(status.backgroundRun.unknownRequests, 1)
    const round = status.tokenRounds.entries[0]
    assert.equal(round.tokensUnknown, false); assert.deepEqual(round.tokens, { input: 54, output: 6, total: 60 })
    assert.equal(round.unknownRequests, 1)
    assert.equal(status.tokenRounds.sums.partial, 1)
    const log = (await request('/pet/log?n=500', {}, 'GET')).entries
    assert.ok(log.some(x => x.type === 'bg-progress' && x.stage === 'diagnostic' && /ETIMEDOUT/.test(x.text)))
    assert.doesNotMatch(JSON.stringify(log), /fixture-private-dm-body|fixture-secret-content/)
    assert.ok(log.some(x => x.type === 'bg-progress' && x.stage === 'tool-done' && /bili_say/.test(x.text)))
    assert.ok(log.some(x => x.type === 'bg-done' && x.tokens?.total === 60 && x.unknownRequests === 1))
    await assert.rejects(client.post({ action: 'tools-list' }), /撤销或过期/)
  } finally {
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    cp.spawn = originalSpawn; syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('stopping during DM qualification never submits a new send after the pending read returns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-stop-dm-')), home = join(root, 'bili-duty')
  mkdirSync(home)
  const cli = join(root, 'mock-cli.js'); writeFileSync(cli, '// child spawn mocked')
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dshBin: cli, learnAutoReview: false, backgroundModelId: 'buddy/fixture', reportLevel: 'off', autoReplyDm: true }))
  const cp = createRequire(import.meta.url)('node:child_process'), originalSpawn = cp.spawn, originalCall = McpClient.prototype.call
  const cleanups = []
  let handler, childEnv, child, reads = 0, sends = 0, releaseRead, readStarted
  const reading = new Promise(resolve => { readStarted = resolve })
  const released = new Promise(resolve => { releaseRead = resolve })
  const calls = []
  cp.spawn = (command, args, options) => {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = null; proc.kill = () => true
    if (options.env?.BILI_DUTY_RELAY_CAPABILITY) { child = proc; childEnv = options.env }
    return proc
  }; syncBuiltinESMExports()
  McpClient.prototype.call = async function(name) {
    calls.push(name)
    if (name === 'bili_dm_list') {
      if (++reads === 1) { readStarted(); await released }
      return { items: [{ uid: '123', msg_seqno: '456', is_follow: true, days_ago: 0 }] }
    }
    if (name === 'bili_send_message') { sends++; return { success: true } }
    throw new Error('unexpected MCP call ' + name)
  }
  const llm = { listProviders: () => [{ id: 'buddy' }] }
  const ctx = {
    logger: { info() {} }, get: key => key === 'llm' ? llm : key === 'dshHomePath' ? (...parts) => join(root, ...parts) : key === 'agents' ? { list: () => [] } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } },
  }
  async function request(path, body = {}) {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = 'POST'; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(code) { this.code = code }, end(text) { this.body = JSON.parse(text) } }
    const pending = handler(req, res); req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); await pending
    return res.body
  }
  try {
    apply(ctx, {}); await new Promise(resolve => setImmediate(resolve))
    assert.equal((await request('/pet/start', { mode: 'background' })).started, true)
    const pending = backgroundMcpRequest({ id: 1, method: 'tools/call', params: { name: 'bili_dm_reply', arguments: { uid: '123', msg_seqno: '456', text: '这条先等一下，小鱼看到了。' } } }, createRelayClient(childEnv))
    const settled = pending.then(value => value, error => ({ error }))
    await reading
    assert.equal((await request('/pet/stop')).stopped, true)
    releaseRead(); await settled
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(sends, 0)
    assert.ok(!calls.includes('bili_send_message'))
    child.emit('close', null)
    // A fresh task still works: cancelled execution context must not bleed into it.
    assert.equal((await request('/pet/start', { mode: 'background' })).started, true)
    const result = await backgroundMcpRequest({ id: 2, method: 'tools/call', params: { name: 'bili_dm_reply', arguments: { uid: '123', msg_seqno: '456', text: '小鱼刚看到，先慢慢来呀。' } } }, createRelayClient(childEnv))
    assert.equal(result.result.isError, false)
    assert.equal(JSON.parse(result.result.content[0].text).success, true)
    assert.equal(sends, 1)
    child.emit('close', 0)
  } finally {
    releaseRead()
    for (const cleanup of cleanups.reverse()) { try { cleanup() } catch {} }
    cp.spawn = originalSpawn; syncBuiltinESMExports(); McpClient.prototype.call = originalCall
    rmSync(root, { recursive: true, force: true })
  }
})

test('background schemas preserve ID strings and reject fabricated human authorization', async () => {
  const schema = toolInputSchema({ id: { type: 'string', required: true }, force: { type: 'boolean' }, action: { type: 'string', enum: ['read', 'add'] } })
  assert.deepEqual(schema.required, ['id'])
  assert.deepEqual(validateToolArguments(schema, { id: '1234567890123456789', action: null }), { id: '1234567890123456789' })
  for (const bad of [{ id: 1234567890123456789 }, { id: 'x', force: true }, { id: 'x', action: 'approve' }, {}]) assert.throws(() => validateToolArguments(schema, bad), /BACKGROUND_TOOL_/)
  assert.ok(!backgroundToolNames({}).includes('bili_reply'))
  assert.ok(backgroundToolNames({ autoReplyDm: true }).includes('bili_dm_reply'))
  // 🐋 后台白名单收窄（规格 §5.4）：无人值守只给书评通道，普通新评论只保留在会话态
  const backgroundNames = backgroundToolNames({ autoComment: true })
  assert.ok(backgroundNames.includes('bili_book_comment'))
  assert.ok(!backgroundNames.includes('bili_comment'))
  // 后台的 bili_reply 只许回楼层：模型看见的 schema rpid 必填（§5.4）；调用校验仍按宿主原始
  // schema（rpid 可缺省），"开关关着 → BACKGROUND_TOOL_DISABLED"先发生；真正的 rpid 拦截在
  // 宿主回调的白名单检查之后（见 index.js）。
  const registry = new Map([['bili_reply', { name: 'bili_reply', description: '', parameters: { bvid: { type: 'string' }, text: { type: 'string' }, rpid: { type: 'string' } } }]])
  const [replyTool] = exposeBackgroundTools(registry, { autoComment: true }, async () => ({}))
  assert.ok(replyTool.inputSchema.required.includes('rpid'))
  const executed = []
  const [lenient] = exposeBackgroundTools(registry, { autoComment: true }, async (name, args) => { executed.push(args); return {} })
  await lenient.execute({ bvid: 'BV1234567890', text: 'x' }, null)
  assert.deepEqual(executed, [{ bvid: 'BV1234567890', text: 'x' }])
})
