import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLedger, withDomResult } from '../lib/whale-ledger.mjs'
import {
  V2_STATUSES, NO_MORE_COMMENTS, V2_DAILY_MAX, findChrome, pickV2Targets,
  judgeDomResult, probeExpression, probeDom,
} from '../lib/whale-dom.mjs'

const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime() // 本地 2026-11-08 12:00
const dayStart = new Date(2026, 10, 8, 0, 0, 0).getTime()
const sentRow = (id, extra = {}) => ({
  id: String(id), bvid: 'BV1Mx476YEnf', rpid: String(323305830000 + Number(id)),
  sent: true, posted_at: new Date(NOW - 3600_000).toISOString(), posted_ts: NOW - 3600_000, ...extra,
})
const ledgerWith = (rows = []) => ({ ...emptyLedger(), posted: rows })

test('V2 三态词表与常量（§10.4）', () => {
  assert.deepEqual([...V2_STATUSES], ['visible', 'hidden', 'unknown'])
  assert.equal(NO_MORE_COMMENTS, '没有更多评论')
  assert.equal(V2_DAILY_MAX, 3)
})

test('pickV2Targets：V1 判 miss/invisible 的行优先核，不受每日随机额度限制', () => {
  const ledger = ledgerWith([
    sentRow(1, { v1_30min: { status: 'hit' } }),
    sentRow(2, { v1_30min: { status: 'miss' } }),
    sentRow(3, { v1_24h: { status: 'invisible' } }),
  ])
  const picked = pickV2Targets(ledger, { nowTs: NOW, random: () => 0 })
  assert.deepEqual(picked.map((t) => t.id), ['2', '3'])
  assert.deepEqual(picked.map((t) => t.reason), ['v1-miss', 'v1-miss'])
})

test('pickV2Targets：单轮最多 3 条（§10.4 上限）', () => {
  const rows = Array.from({ length: 5 }, (_, i) => sentRow(i + 1, { v1_30min: { status: 'miss' } }))
  assert.equal(pickV2Targets(ledgerWith(rows), { nowTs: NOW, max: 3 }).length, 3)
  assert.equal(pickV2Targets(ledgerWith(rows), { nowTs: NOW }).length, 3)
})

test('pickV2Targets：没有 V1 信号时每天随机补 1 条；当天已抽样过就不再跑', () => {
  const rows = [sentRow(1, { v1_30min: { status: 'hit' } }), sentRow(2, { v1_30min: { status: 'hit' } })]
  const picked = pickV2Targets(ledgerWith(rows), { nowTs: NOW, random: () => 0.99 })
  assert.equal(picked.length, 1)
  assert.equal(picked[0].id, '2', '随机源 0.99 落在第 2 条')
  assert.equal(picked[0].reason, 'daily-sample')
  const sampled = ledgerWith(rows.map((row) => withDomResult(ledgerWith([row]), row.id, { at: new Date(dayStart + 60_000).toISOString(), status: 'visible' }).posted[0]))
  assert.deepEqual(pickV2Targets(sampled, { nowTs: NOW }), [], '当天已有 v2_dom ⇒ 不再抽样')
})

test('pickV2Targets：已核过（有 v2_dom）的行不重核；没有已发行返回空', () => {
  const done = sentRow(1, { v2_dom: { ts: NOW - 7200_000, status: 'visible' } })
  assert.deepEqual(pickV2Targets(ledgerWith([done]), { nowTs: NOW }), [])
  assert.deepEqual(pickV2Targets(emptyLedger(), { nowTs: NOW }), [])
  const queuedOnly = ledgerWith([{ id: 'wl-1', bvid: 'BV1Mx476YEnf', sent: false }])
  assert.deepEqual(pickV2Targets(queuedOnly, { nowTs: NOW }), [], '没真正发出的行不核')
})

test('judgeDomResult：探针没跑起来 → unknown（绝不误判 hidden）', () => {
  assert.deepEqual(judgeDomResult(null, { mid: '1' }), { status: 'unknown', how: 'dom:error', note: '探针没跑起来：no-result' })
  const r = judgeDomResult({ ok: false, error: 'Chrome 没写出 DevToolsActivePort' }, { mid: '1' })
  assert.equal(r.status, 'unknown')
  assert.equal(r.how, 'dom:error')
  assert.match(r.note, /DevToolsActivePort/)
})

test('judgeDomResult：列表没完整加载 → unknown（§10.4 只认完整加载）', () => {
  const r = judgeDomResult({ ok: true, complete: false, threads: 3, scroll_loops: 30, mine: [] }, { mid: '1' })
  assert.equal(r.status, 'unknown')
  assert.equal(r.how, 'dom:incomplete')
  assert.match(r.note, /threads=3/)
})

test('judgeDomResult：完整加载 + 没找到 = hidden（L2/L3 的唯一信号）', () => {
  const r = judgeDomResult({ ok: true, complete: true, threads: 1, mine: [] }, { mid: '3707002496747705' })
  assert.equal(r.status, 'hidden')
  assert.equal(r.how, 'dom:complete-not-found')
  assert.match(r.note, /3707002496747705/)
})

test('judgeDomResult：完整加载 + 找到本人评论 = visible；正文核对钩子前 12 字', () => {
  const hook = '03:54：单个老板赚多少，不看自家压榨多狠'
  const hit = judgeDomResult({ ok: true, complete: true, threads: 1, mine: [{ length: 144, head: hook.slice(0, 40) }] }, { mid: '1', hook })
  assert.equal(hit.status, 'visible')
  assert.equal(hit.how, 'dom:found')
  assert.match(hit.note, /正文含钩子前 12 字/)
  const mismatch = judgeDomResult({ ok: true, complete: true, threads: 1, mine: [{ length: 144, head: '完全不同的正文' }] }, { mid: '1', hook })
  assert.equal(mismatch.status, 'visible', '找到就是可见（正文不符只提示人工复核，不改判三态）')
  assert.match(mismatch.note, /未匹配钩子前缀/)
  const noHook = judgeDomResult({ ok: true, complete: true, threads: 1, mine: [{ length: 144, head: 'x' }] }, { mid: '1' })
  assert.equal(noHook.status, 'visible')
})

test('probeExpression：占位符全部替换、不含链接字段（模型不见链接）', () => {
  const expr = probeExpression({ mid: '3707002496747705' })
  assert.ok(expr.includes(JSON.stringify('3707002496747705')))
  assert.ok(expr.includes(JSON.stringify(NO_MORE_COMMENTS)))
  assert.ok(!expr.includes('__MID__'))
  assert.ok(!expr.includes('__END__'))
  assert.ok(!expr.includes('__MAXSCROLL__'))
  assert.ok(expr.includes('bili-comments'))
  assert.ok(expr.includes('data-user-profile-id'))
})

test('probeDom：入参不合法 / 找不到浏览器都结构化失败（不抛、不误判）', async () => {
  assert.equal((await probeDom({ bvid: 'not-a-bv', mid: '1', cred: {} })).ok, false)
  const missing = await probeDom({ bvid: 'BV1Mx476YEnf', mid: '1', cred: {}, chromePath: '/definitely/not/chrome' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /Chrome/)
})

test('probeDom：Chrome 起来了但 CDP 不可用 → ok:false（由 judge 落 unknown）', async () => {
  const child = { killed: false, kill() { this.killed = true } }
  const raw = await probeDom({
    bvid: 'BV1Mx476YEnf', mid: '1', cred: {},
    chromePath: '/fake/chrome', find: () => '/fake/chrome',
    spawnImpl: () => child,
    exists: () => true,
    read: () => '54321\n/devtools/browser/abc\n',
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED') },
    rm: () => {},
  })
  assert.equal(raw.ok, false)
  assert.match(raw.error, /ECONNREFUSED/)
  assert.equal(child.killed, true, '失败也要收掉子进程')
})

test('findChrome：WHALE_CHROME_PATH 优先，找不到回 null（不猜路径）', () => {
  const env = { WHALE_CHROME_PATH: '/custom/chrome' }
  assert.equal(findChrome({ env, exists: () => true }), '/custom/chrome')
  assert.equal(findChrome({ env: {}, exists: () => false }), null)
  assert.equal(findChrome({ env: {}, exists: (p) => p.includes('Google Chrome') }), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
})
