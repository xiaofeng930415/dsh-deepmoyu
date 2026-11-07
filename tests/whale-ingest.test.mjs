import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  emptyLedger, withGateHit, withBeforeSend, withAfterSend,
  withV1Result, withIngest, dueV1Checks, selectPendingIngest, V1_SLOTS, V1_DELAYS_MS,
} from '../lib/whale-ledger.mjs'
import { safeRpidInt, buildIngestPayload, runPush, ingestRows, WHALE_INGEST_NOTE } from '../lib/whale-push.mjs'
import { sweepV1 } from '../lib/whale-verify.mjs'

const NL = String.fromCharCode(10)
const QUARK_BLOCK = ['鲸鱼整理的《小岛经济学》资源包', 'https://pan.quark.cn/s/60fc0b3c0f8d', '提取码：22EM'].join(NL)
const BAIDU_BLOCK = ['鲸鱼整理的《杀死一只知更鸟》资源包', '链接：https://pan.baidu.com/s/1TKx', '提取码：ktiy'].join(NL)
const BASE_TS = Date.parse('2026-11-07T12:00:00.000Z')

const fullRow = (over = {}) => ({
  id: 'wl-x',
  bvid: 'BV1234567890',
  book_id: 'island-economics',
  book_title: '小岛经济学',
  hook: '讲复利那三分钟本鱼来回听了三遍。',
  block: QUARK_BLOCK,
  order_kind: 'quark',
  like_line: '',
  char_count: 60,
  rpid: '317687203025',
  guard_status: 'sent',
  sent: true,
  aid: 1122334455667,
  mid: 3707002496747705,
  posted_at: '2026-11-07T12:00:00.000Z',
  posted_ts: BASE_TS,
  entry_stat: { view: 1200, reply: 45, like: 88, danmaku: 7, pubdate_ts: 1699000000 },
  ...over,
})

test('safeRpidInt keeps safe decimal strings and rejects the rest', () => {
  assert.equal(safeRpidInt('317687203025'), 317687203025)
  assert.equal(safeRpidInt(123), 123)
  assert.equal(safeRpidInt(''), null, '空串拒绝')
  assert.equal(safeRpidInt('abc'), null)
  assert.equal(safeRpidInt('0'), null, '0 不是合法 rpid')
  assert.equal(safeRpidInt('99999999999999999999999'), null, '超安全整数拒推（§10.2 精度闸）')
})

test('buildIngestPayload maps one ledger row to the snake_case server contract', () => {
  const { payload, error } = buildIngestPayload(fullRow())
  assert.equal(error, undefined)
  assert.deepEqual(Object.keys(payload), ['comments', 'videoSnapshots', 'commentSnapshots', 'upSnapshots'])
  const c = payload.comments[0]
  assert.equal(c.bvid, 'BV1234567890')
  assert.equal(c.rpid, 317687203025, 'rpid 以数字入库（安全整数已验）')
  assert.equal(c.book_id, 'island-economics')
  assert.equal(c.book_title, '小岛经济学')
  assert.equal(c.aid, 1122334455667)
  assert.equal(c.mid, 3707002496747705)
  assert.equal(c.order_kind, 'quark_first', '盘别映射到台账枚举')
  assert.equal(c.note, WHALE_INGEST_NOTE)
  assert.equal(c.deleted, 0)
  assert.equal(c.pool_score, null)
  assert.equal(c.pool_signals, null)
  assert.ok(c.variant_raw.includes('讲复利') && c.variant_raw.includes('pan.quark.cn'), 'variant_raw = hook + block 全文')
  const v = payload.videoSnapshots[0]
  assert.equal(v.source, 'entry')
  assert.equal(v.captured_ts, BASE_TS, 'entry 快照的 captured_ts = posted_ts')
  assert.equal(v.view, 1200)
  assert.equal(v.pubdate_ts, 1699000000)
})

test('buildIngestPayload handles baidu blocks, missing stats and text-only backfill rows', () => {
  const { payload } = buildIngestPayload(fullRow({ order_kind: 'baidu', block: BAIDU_BLOCK, entry_stat: null }))
  assert.equal(payload.comments[0].order_kind, 'baidu_first')
  assert.equal(payload.videoSnapshots[0].view, null, '统计缺省落 null（服务端可空）')
  const textOnly = buildIngestPayload(fullRow({ hook: '', block: '', text: '对账补记的正文', entry_stat: undefined }))
  assert.equal(textOnly.payload.comments[0].variant_raw, '对账补记的正文', '无 hook 行退回 text')
})

test('buildIngestPayload rejects incomplete rows and unsafe rpid', () => {
  assert.equal(buildIngestPayload(fullRow({ book_id: '' })).error, 'row-incomplete')
  assert.equal(buildIngestPayload(fullRow({ posted_ts: 0 })).error, 'row-incomplete')
  assert.equal(buildIngestPayload(fullRow({ rpid: '99999999999999999999999' })).error, 'rpid-unsafe')
  assert.equal(buildIngestPayload(fullRow({ rpid: '' })).error, 'rpid-missing')
})

test('withV1Result writes known slots only and ignores unknown ids', () => {
  let ledger = withAfterSend(
    withBeforeSend(withGateHit(emptyLedger(), { id: 'wl-a', bvid: 'BV1234567890', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK }), 'wl-a', { hook: 'h', block: QUARK_BLOCK, charCount: 10 }),
    'wl-a',
    { rpid: '111', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' },
  )
  ledger = withV1Result(ledger, 'wl-a', 'v1_30min', { status: 'hit', likes: 3, floor: 5, rcount: 0, how: '顶层·按时间前 1 页' })
  const row = ledger.posted[0]
  assert.equal(row.v1_30min.status, 'hit')
  assert.equal(row.v1_30min.likes, 3)
  assert.equal(row.v1_30min.floor, 5)
  assert.ok(row.v1_30min.ts > 0)
  ledger = withV1Result(ledger, 'wl-a', 'v1_bogus', { status: 'hit' })
  assert.equal(row.v1_bogus, undefined, '未知槽位拒绝')
  ledger = withV1Result(ledger, 'wl-none', 'v1_30min', { status: 'hit' })
  assert.equal(ledger.posted.length, 1, '未知 id 忽略')
})

test('withIngest records success once and caps retries with a give-up seal', () => {
  let ledger = withGateHit(emptyLedger(), { id: 'wl-a', bvid: 'BV1234567890', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'wl-a', { rpid: '111', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withIngest(ledger, 'wl-a', { ok: true, counts: { comments: 1 } })
  let row = ledger.posted[0]
  assert.equal(row.ingest_ok, true)
  assert.ok(row.ingest_at, '成功落 ingest_at，不再重推')
  assert.deepEqual(row.ingest_counts, { comments: 1 })
  ledger = withIngest(ledger, 'wl-a', { ok: false, error: 'push-exit-1' })
  row = ledger.posted[0]
  assert.equal(row.ingest_ok, true, '已成功的行不会被失败覆盖')
  ledger = withGateHit(ledger, { id: 'wl-b', bvid: 'BV2222222222', bookId: 'y', bookTitle: 'y', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'wl-b', { rpid: '222', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  for (let i = 0; i < 4; i++) ledger = withIngest(ledger, 'wl-b', { ok: false, error: 'push-timeout' })
  row = ledger.posted.find((r) => r.id === 'wl-b')
  assert.equal(row.ingest_attempts, 4)
  assert.equal(row.ingest_given_up, undefined, '未到上限不封口')
  ledger = withIngest(ledger, 'wl-b', { ok: false, error: 'push-timeout' })
  row = ledger.posted.find((r) => r.id === 'wl-b')
  assert.equal(row.ingest_attempts, 5)
  assert.equal(row.ingest_given_up, true, '第 5 次失败封口')
  assert.ok(row.ingest_at, '封口落 ingest_at（select 不再选中）')
})

test('dueV1Checks fires at T+30min and T+24h, one slot per row per sweep', () => {
  let ledger = withGateHit(emptyLedger(), { id: 'wl-a', bvid: 'BV1234567890', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'wl-a', { rpid: '111', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withGateHit(ledger, { id: 'wl-b', bvid: 'BV2222222222', bookId: 'y', bookTitle: 'y', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'wl-b', { rpid: '222', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withGateHit(ledger, { id: 'wl-c', bvid: 'BV3333333333', bookId: 'z', bookTitle: 'z', block: QUARK_BLOCK })
  ledger = withBeforeSend(ledger, 'wl-c', { hook: 'h', block: QUARK_BLOCK, charCount: 1 })
  assert.equal(dueV1Checks(ledger, BASE_TS + 29 * 60_000).length, 0, 'T+30 前不查')
  let due = dueV1Checks(ledger, BASE_TS + 31 * 60_000)
  assert.deepEqual(due.map((d) => d.row.id), ['wl-a', 'wl-b'], '未发送行（wl-c）不参与')
  assert.ok(due.every((d) => d.slot === 'v1_30min'))
  ledger = withV1Result(ledger, 'wl-a', 'v1_30min', { status: 'miss' })
  due = dueV1Checks(ledger, BASE_TS + 25 * 3600_000)
  assert.deepEqual(due.map((d) => d.slot), ['v1_24h', 'v1_30min'], '填完 30min 槽后轮到各自下一槽')
  due = dueV1Checks(ledger, BASE_TS + 25 * 3600_000, { max: 1 })
  assert.equal(due.length, 1, 'max 封顶')
})

test('selectPendingIngest picks only complete unsent-ingest rows', () => {
  let ledger = withGateHit(emptyLedger(), { id: 'ok', bvid: 'BV1234567890', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK, aid: 5, mid: 6 })
  ledger = withAfterSend(ledger, 'ok', { rpid: '111', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withGateHit(ledger, { id: 'already', bvid: 'BV1111111111', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'already', { rpid: '222', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withIngest(ledger, 'already', { ok: true, counts: {} })
  ledger = withGateHit(ledger, { id: 'nobook', bvid: 'BV2222222222', bookId: '', bookTitle: '', block: QUARK_BLOCK })
  ledger = withAfterSend(ledger, 'nobook', { rpid: '333', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  ledger = withGateHit(ledger, { id: 'notsent', bvid: 'BV3333333333', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK })
  ledger = withBeforeSend(ledger, 'notsent', { hook: 'h', block: QUARK_BLOCK, charCount: 1 })
  const ids = selectPendingIngest(ledger).map((r) => r.id)
  assert.deepEqual(ids, ['ok'], '已入库 / 缺 book_id / 未发送的都不选')
})

const fakeChild = () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { write: (d) => { child.stdinBody = String(d) }, end: () => {}, on: () => {} }
  child.kill = () => { child.killed = true }
  return child
}

test('runPush parses counts on exit 0 and never echoes stderr on failure', async () => {
  const payload = { a: 1 }
  const good = fakeChild()
  const ok = await runPush({
    payload, pythonBin: 'py', scriptPath: 'push.py', timeoutMs: 5000,
    spawnImpl: () => { queueMicrotask(() => { good.stdout.emit('data', 'noise' + NL + '已入库：comments=1 videoSnapshots=1 commentSnapshots=0 upSnapshots=0' + NL); good.emit('close', 0) }); return good },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.counts, { comments: 1, videoSnapshots: 1, commentSnapshots: 0, upSnapshots: 0 })
  assert.ok(good.stdinBody.includes('"a":1'), 'payload 走 stdin')
  const bad = fakeChild()
  const fail = await runPush({
    payload, pythonBin: 'py', scriptPath: 'push.py', timeoutMs: 5000,
    spawnImpl: () => { queueMicrotask(() => { bad.stderr.emit('data', 'SECRET-SERVER-DETAIL'); bad.emit('close', 1) }); return bad },
  })
  assert.equal(fail.ok, false)
  assert.equal(fail.error, 'push-exit-1')
  assert.ok(!JSON.stringify(fail).includes('SECRET-SERVER-DETAIL'), 'stderr 永不进结果')
})

test('runPush reports spawn errors and timeouts without throwing', async () => {
  const err = await runPush({
    payload: {}, pythonBin: 'py', scriptPath: 'push.py', timeoutMs: 5000,
    spawnImpl: () => { const c = fakeChild(); queueMicrotask(() => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }))); return c },
  })
  assert.equal(err.error, 'spawn-failed:ENOENT')
  const slow = fakeChild()
  const timeout = await runPush({
    payload: {}, pythonBin: 'py', scriptPath: 'push.py', timeoutMs: 30,
    spawnImpl: () => slow,
  })
  assert.equal(timeout.error, 'push-timeout')
  assert.equal(slow.killed, true, '超时后杀进程')
})

test('ingestRows builds, pushes and reports per-row outcomes', async () => {
  const calls = []
  const rows = [fullRow({ id: 'r1' }), fullRow({ id: 'r2', book_id: '' }), fullRow({ id: 'r3' })]
  const outcomes = await ingestRows({
    rows, pythonBin: 'py', scriptPath: 'push.py', max: 5,
    runPushImpl: async ({ payload }) => { calls.push(payload.comments[0].book_id); return { ok: true, counts: { comments: 1 } } },
  })
  assert.deepEqual(calls, ['island-economics', 'island-economics'], 'build 失败的行不进 push')
  assert.equal(outcomes.length, 3)
  assert.equal(outcomes[1].error, 'row-incomplete')
  assert.equal(outcomes[0].ok, true)
  const bounded = await ingestRows({ rows, pythonBin: 'py', scriptPath: 'p', max: 1, runPushImpl: async () => ({ ok: true }) })
  assert.equal(bounded.length, 1, 'max 封顶')
})

const dueLedger = () => {
  let ledger = withGateHit(emptyLedger(), { id: 'wl-a', bvid: 'BV1234567890', bookId: 'island-economics', bookTitle: '小岛经济学', block: QUARK_BLOCK, aid: 1122334455667 })
  ledger = withAfterSend(ledger, 'wl-a', { rpid: '317687203025', guardStatus: 'sent', sent: true, postedAt: '2026-11-07T12:00:00.000Z' })
  return ledger
}

test('sweepV1 writes hit results with floor from reply/detail', async () => {
  let applied = dueLedger()
  const seen = {}
  const result = await sweepV1({
    trigger: '测试',
    readLedger: () => applied,
    writeRow: (mutate) => { applied = mutate(applied) },
    cred: { sessdata: 's', bili_jct: 'j', buvid3: 'b' },
    nowTs: BASE_TS + 31 * 60_000,
    sleepImpl: async () => {},
    verifyOneImpl: async (record, io) => { seen.record = record; io.aidCache.set(record.bv, { aid: '1122334455667' }); return { visible: true, likes: 3, how: '顶层·按时间前 1 页' } },
    replyDetailImpl: async (aid, rpid) => {
      seen.detail = { aid, rpid }
      return { code: 0, data: { root: { floor: 5, like: 3, rcount: 0 } } }
    },
  })
  assert.equal(result.checked, 1)
  assert.deepEqual(seen.record, { rpid: '317687203025', bv: 'BV1234567890', root: '0' })
  assert.deepEqual(seen.detail, { aid: '1122334455667', rpid: '317687203025' })
  const row = applied.posted[0]
  assert.equal(row.v1_30min.status, 'hit')
  assert.equal(row.v1_30min.floor, 5)
  assert.equal(row.v1_30min.rcount, 0)
  assert.equal(row.v1_30min.likes, 3)
})

test('sweepV1 keeps miss/invisible without visibility claims and records probe codes', async () => {
  let applied = dueLedger()
  await sweepV1({
    readLedger: () => applied,
    writeRow: (mutate) => { applied = mutate(applied) },
    cred: { sessdata: 's' },
    nowTs: BASE_TS + 31 * 60_000,
    sleepImpl: async () => {},
    verifyOneImpl: async () => ({ visible: false, how: 'x' }),
    replyDetailImpl: async () => { throw new Error('不应调用：invisible 不取 floor') },
  })
  assert.equal(applied.posted[0].v1_30min.status, 'invisible')
  assert.equal(applied.posted[0].v1_30min.floor, null)
  applied = dueLedger()
  await sweepV1({
    readLedger: () => applied,
    writeRow: (mutate) => { applied = mutate(applied) },
    cred: { sessdata: 's' },
    nowTs: BASE_TS + 31 * 60_000,
    sleepImpl: async () => {},
    verifyOneImpl: async () => ({ visible: true, how: 'x' }),
    replyDetailImpl: async () => ({ code: 12006 }),
  })
  assert.equal(applied.posted[0].v1_30min.status, 'hit')
  assert.equal(applied.posted[0].v1_30min.probe_code, '12006', '12006 只进探测码，不反推可见性（§10.3）')
})

test('sweepV1 skips without credential or due rows', async () => {
  const noCred = await sweepV1({ readLedger: dueLedger, writeRow: () => {}, cred: null })
  assert.equal(noCred.skipped, 'no-credential')
  const fresh = await sweepV1({ readLedger: () => dueLedger(), writeRow: () => {}, cred: { sessdata: 's' }, nowTs: BASE_TS + 1000 })
  assert.equal(fresh.checked, 0, '未到期不查')
})

test('vendored push.py matches the upstream channel contract (dry-run smoke)', (t) => {
  const probe = spawnSync('python3', ['-c', 'import sys; sys.exit(0)'])
  if (probe.error || probe.status !== 0) return t.skip('本机没有 python3，跳过 dry-run 冒烟')
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'bili-push', 'push.py')
  const payload = buildIngestPayload(fullRow()).payload
  const run = spawnSync('python3', [script, '--dry-run'], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 20000 })
  assert.equal(run.status, 0, 'exit 0 = ' + (run.stderr || run.stdout).slice(0, 200))
  assert.ok(run.stdout.includes('校验通过'), 'dry-run 校验通过')
  assert.ok(run.stdout.includes('comments=1'), '行数摘要')
  assert.ok(run.stdout.includes('pan.quark.cn'), 'payload 原文在 dry-run 输出里')
})
