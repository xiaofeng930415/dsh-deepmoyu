/**
 * T8 单测：私信值守（规格 #1751 A/E/F 段）。
 *
 * 缝：
 *   ① **纯函数缝**（lib/dm-watch.mjs）—— 时段边界 / 三与 / 退避阶梯 / 停损 / 摘要，
 *      假时钟钉住，零 IO。
 *   ② **宿主缝**（tests 里的假 ctx + 假 MCP）—— 开关配置真的能存进来、
 *      status 真的带 dmWatch、dm_reply 撞 21046 真的停值守。
 *      不引入新 seam：沿用 send-review 那套 fixture。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DM_WATCH_POLL_MIN, DM_WATCH_POLL_MAX, DM_WATCH_DEFAULT_START, DM_WATCH_DEFAULT_END,
  DM_WATCH_BACKOFF_MS, dmWatchInWindow, dmWatchDue, dmWatchMarkPolled, dmWatchBackoff,
  dmWatchStop, dmWatchStopClear, dmWatchSummary,
} from '../lib/dm-watch.mjs'
import { apply } from '../index.js'
import { McpClient } from '../lib/mcp.mjs'

/* ── ① 纯函数 ────────────────────────────────────────────────────────────── */

const at = (h, m = 0) => new Date(2026, 10, 10, h, m, 0).getTime()

test('the awake window honours cross-midnight spans and refuses to guess on malformed config', () => {
  // 默认 07:00–24:00：醒着
  assert.equal(dmWatchInWindow(new Date(at(7, 0))), true)
  assert.equal(dmWatchInWindow(new Date(at(23, 59))), true)
  // 夜间不回
  assert.equal(dmWatchInWindow(new Date(at(0, 30))), false)
  assert.equal(dmWatchInWindow(new Date(at(6, 59))), false)
  assert.equal(dmWatchInWindow(new Date(at(23, 59)), '07:00', '23:00'), false)
  // 跨零点：22:00–06:00
  assert.equal(dmWatchInWindow(new Date(at(23, 0)), '22:00', '06:00'), true)
  assert.equal(dmWatchInWindow(new Date(at(2, 0)), '22:00', '06:00'), true)
  assert.equal(dmWatchInWindow(new Date(at(12, 0)), '22:00', '06:00'), false)
  // 畸形/空窗口 ⇒ 不猜（宁可不动，也不半夜回人）
  assert.equal(dmWatchInWindow(new Date(at(12, 0)), 'abc', '24:00'), false)
  assert.equal(dmWatchInWindow(new Date(at(12, 0)), '', ''), false)
  assert.equal(dmWatchInWindow(new Date(at(12, 0)), '08:00', '08:00'), false)
})

test('the three-way gate is dmWatch AND autoReplyDm AND NOT sendReview', () => {
  const now = at(12, 0)
  // 三个都满足 ⇒ due
  assert.equal(dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: false }, {}, now).due, true)
  // 缺一不可；且每一句 why 都说清是哪一条
  assert.equal(dmWatchDue({ dmWatch: false, autoReplyDm: true }, {}, now).due, false)
  assert.match(dmWatchDue({ dmWatch: false, autoReplyDm: true }, {}, now).why, /dmWatch 未开启/)
  assert.equal(dmWatchDue({ dmWatch: true, autoReplyDm: false }, {}, now).due, false)
  assert.match(dmWatchDue({ dmWatch: true, autoReplyDm: false }, {}, now).why, /自动回复私信/)
  // 人审速度就是 SLA：开着预览 ⇒ 值守不启动
  assert.equal(dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: true }, {}, now).due, false)
  assert.match(dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: true }, {}, now).why, /发送预览/)
})

test('the poll interval comes from the backoff ladder and reading never touches the send pace', () => {
  const now = at(12, 0)
  // 刚看过 ⇒ 未到下一跳
  const seen = { dmWatch: { lastPollAt: now - 60_000 } }
  const r = dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: false }, seen, now)
  assert.equal(r.due, false)
  assert.ok(r.waitMs > 0)
  // 到点了 ⇒ 该看
  const due = { dmWatch: { lastPollAt: now - DM_WATCH_BACKOFF_MS[0] } }
  assert.equal(dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: false }, due, now).due, true)
  // 退避档越高等越久（3 → 5 → 15 分钟）
  const steps = [0, 1, 2].map((step) => {
    const b = dmWatchDue({ dmWatch: true, autoReplyDm: true, sendReview: false }, { dmWatch: { lastPollAt: now - 1000, backoffStep: step } }, now)
    return b.due ? 0 : b.waitMs
  })
  assert.deepEqual(steps, [DM_WATCH_BACKOFF_MS[0] - 1000, DM_WATCH_BACKOFF_MS[1] - 1000, DM_WATCH_BACKOFF_MS[2] - 1000])
  // 档位封顶（不会无限升）
  const capped = dmWatchBackoff({ backoffStep: DM_WATCH_BACKOFF_MS.length - 1 }, now)
  assert.equal(capped.book.backoffStep, DM_WATCH_BACKOFF_MS.length - 1)
  // 看一眼成功 ⇒ 档位归零
  assert.equal(dmWatchMarkPolled({ backoffStep: 2 }, now).backoffStep, 0)
  assert.equal(dmWatchMarkPolled({}, now).lastPollAt, now)
})

test('a 21046 stop parks the watch and only an explicit clear resumes it', () => {
  const now = at(12, 0)
  const until = now + 24 * 3600_000
  const stopped = dmWatchStop({ lastPollAt: now }, until, '21046')
  assert.equal(stopped.stopUntil, until)
  assert.equal(stopped.stopCode, '21046')
  // 停满前不起轮（哪怕三与全满足、时段也对、间隔也到了）
  const cfg = { dmWatch: true, autoReplyDm: true, sendReview: false }
  const r = dmWatchDue(cfg, { dmWatch: stopped }, now + 60_000)
  assert.equal(r.due, false)
  assert.match(r.why, /停损中/)
  // 停满后自动恢复（不需要人签 —— 平台禁令本身有明确时限）
  assert.equal(dmWatchDue(cfg, { dmWatch: stopped }, until + 1).due, true)
  // 显式清除：把 stopUntil 归零、清掉 stopCode/stopAt
  const cleared = dmWatchStopClear(stopped)
  assert.equal(cleared.stopUntil, 0)
  assert.equal(cleared.stopCode, '')
  assert.equal(cleared.stopAt, undefined)
  assert.equal(cleared.lastPollAt, now, '清停损不动别的字段')
})

test('the summary never lies about the gating reason', () => {
  const now = at(12, 0)
  // 只开了 dmWatch，autoReplyDm 没开 ⇒ configOnly=true 但 enabled=false（界面要能区分）
  const s1 = dmWatchSummary({ dmWatch: true, autoReplyDm: false }, { dmWatch: { lastPollAt: now - 600_000 } }, now)
  assert.equal(s1.configOnly, true)
  assert.equal(s1.enabled, false)
  assert.equal(s1.due, false)
  assert.match(s1.why, /自动回复私信/)
  // 全开且时段内 ⇒ enabled + inWindow
  const s2 = dmWatchSummary({ dmWatch: true, autoReplyDm: true, sendReview: false, dmWatchStart: '07:00', dmWatchEnd: '24:00' }, { dmWatch: { lastPollAt: now - 600_000 } }, now)
  assert.equal(s2.enabled, true)
  assert.equal(s2.inWindow, true)
  assert.equal(s2.due, true)
  assert.equal(s2.lastPollAt, new Date(now - 600_000).toISOString())
  // 停损中要在摘要里看得见
  const s3 = dmWatchSummary({ dmWatch: true, autoReplyDm: true }, { dmWatch: { stopUntil: now + 3600_000, stopCode: '21046' } }, now)
  assert.equal(s3.enabled, true)
  assert.equal(s3.stop.code, '21046')
  assert.equal(s3.due, false)
})

test('defaults and bounds are pinned so nobody silently widens the poll range', () => {
  assert.equal(DM_WATCH_POLL_MIN, 3)
  assert.equal(DM_WATCH_POLL_MAX, 5)
  assert.equal(DM_WATCH_DEFAULT_START, '07:00')
  assert.equal(DM_WATCH_DEFAULT_END, '24:00')
  assert.deepEqual(DM_WATCH_BACKOFF_MS, [180_000, 300_000, 900_000])
})

/* ── ② 宿主缝 ────────────────────────────────────────────────────────────── */

const root = mkdtempSync(join(tmpdir(), 'fish-dm-watch-'))
let sequence = 0
const flush = () => new Promise(resolve => setImmediate(resolve))

async function fixture(extra = {}) {
  const dir = join(root, String(++sequence)), home = join(dir, 'bili-duty')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.json'), JSON.stringify({ sendReview: false, autoComment: false, replyToComments: true,
    autoReplyDm: true, dmReplyFollowedOnly: false, learnAutoReview: false, reportLevel: 'off', ...extra }))
  writeFileSync(join(home, 'state.json'), JSON.stringify({ unrelated: 61 }))
  const cleanups = [], tools = new Map(), calls = []
  const agent = { id: 'watch-fish-' + sequence, session: { header: { agentPreset: 'dafeiyu', cwd: dir } },
    ctx: { tools: { register(spec) { tools.set(spec.name, spec); return () => tools.delete(spec.name) } } } }
  let handler, reply = { success: true }
  const original = McpClient.prototype.call
  McpClient.prototype.call = async function(name) { calls.push({ name }); return typeof reply === 'function' ? reply(name) : reply }
  const ctx = { logger: { info() {} }, get: key => key === 'dshHomePath' ? (...parts) => join(dir, ...parts) : key === 'agents' ? { list: () => [agent], get: id => id === agent.id ? agent : undefined } : undefined,
    tools: { register() { throw new Error('GLOBAL_TOOL_REGISTRATION_FORBIDDEN') } }, settings: { describe: () => [] }, on() { return () => {} },
    effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
    webServer: { register(route) { handler = route.handler; return { dispose() {} } } } }
  apply(ctx, {}); await flush()
  const request = async (path, body) => {
    const req = new EventEmitter(); req.url = '/api/bili-duty' + path; req.method = body === undefined ? 'GET' : 'POST'; req.headers = {}; req.destroy = () => {}
    const res = { writeHead(status) { this.status = status }, end(value) { this.body = value ? JSON.parse(value) : {} } }
    const promise = handler(req, res)
    if (body !== undefined) { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') }
    await promise; return res.body
  }
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
  const dmLedger = () => {
    try { return JSON.parse(readFileSync(join(home, 'whale-dm', 'ledger.json'), 'utf8')) } catch { return { rows: [], events: [] } }
  }
  return { dir, home, agent, calls, tools, request, state, dmLedger,
    setReply(value) { reply = value },
    close() { for (const fn of cleanups.reverse()) try { fn() } catch {}; McpClient.prototype.call = original } }
}
test.after(() => rmSync(root, { recursive: true, force: true }))

test('the watch switches round-trip through the config route and status reports them', async () => {
  const f = await fixture()
  try {
    // 四个键都必须能从设置页存进来（漏一个 = 界面改了不生效）
    const saved = await f.request('/config', { dmWatch: true, dmWatchPollMinutes: 4, dmWatchStart: '08:30', dmWatchEnd: '23:15' })
    assert.equal(saved.ok, true)
    const st = await f.request('/status')
    assert.equal(st.dmWatch.enabled, true, 'dmWatch + autoReplyDm + !sendReview ⇒ enabled')
    assert.equal(st.dmWatch.configOnly, true)
    assert.deepEqual([st.dmWatch.window.start, st.dmWatch.window.end], ['08:30', '23:15'])
    assert.equal(st.dmWatch.pollMinutes, 3)
    // sendReview 开着 ⇒ enabled  false（人审速度就是 SLA），但 configOnly 仍 true
    await f.request('/config', { sendReview: true })
    const st2 = await f.request('/status')
    assert.equal(st2.dmWatch.enabled, false)
    assert.equal(st2.dmWatch.configOnly, true)
    assert.match(st2.dmWatch.why, /发送预览/)
  } finally { f.close() }
})

test('a 21046 reply parks the watch for 24h and logs the event', async () => {
  const f = await fixture({ dmWatch: true })
  try {
    // 假下游：发送返回 21046
    f.setReply((name) => (name === 'bili_send_message'
      ? { success: false, error: '请在24小时后再发', code: '21046' }
      : name === 'bili_dm_list'
        ? { items: [{ uid: '123', msg_seqno: '456', is_follow: true, days_ago: 0 }] }
        : { success: true }))
    // ⚠️ exec 直接是 { agent }：再包一层 { agent: {agent} } 会让 preset 解析不到 ⇒ mode_required
    const out = await f.tools.get('bili_dm_reply').execute({ uid: '123', msg_seqno: '456', text: '在的' }, { agent: f.agent })
    assert.equal(out.ok, false, JSON.stringify(out))
    // ① state.dmWatch.stopUntil 记了 24h
    const watch = f.state().dmWatch
    assert.ok(Number(watch.stopUntil) > Date.now() + 23 * 3600_000, 'stopUntil 应在 23h 之后')
    assert.equal(watch.stopCode, '21046')
    // ② 台账记事件（正文不入账）
    const ev = f.dmLedger().events.find((e) => e.code === 'dm-risk-blocked')
    assert.ok(ev, 'dm-risk-blocked 事件必须落账')
    assert.equal(ev.uid, '123')
    // ③ 摘要里看得见停损
    const st = await f.request('/status')
    assert.equal(st.dmWatch.stop.code, '21046')
    assert.equal(st.dmWatch.due, false)
  } finally { f.close() }
})
