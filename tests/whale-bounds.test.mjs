import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  emptyBounds, normalizeBounds, readBounds, boundsFileOf,
  OBSERVATION_CAP, STABLE_CAP, FIRST_REVIEW_COUNT,
  endOfLocalDay, stopUntilOf, sentRows, sentOnDay, sentCount,
  openStopRecord, stopState, recoveryRecord, dailyCapState, firstReviewOpen,
  domHiddenStats, escalateStopLevel, evaluateStop, evaluateSpeed, evaluateAlerts, recoveryVerdict,
} from '../lib/whale-bounds.mjs'
import {
  emptyLedger, withStop, withStopCleared, withRecovery, withRecoveryResult,
  withSpeed, withSpeedCleared, withSendOutcome, withDomResult, withEvent, capLedger, sentRowsOf,
} from '../lib/whale-ledger.mjs'

const iso = (ms) => new Date(ms).toISOString()
const NOW = new Date(2026, 10, 8, 12, 0, 0).getTime() // 本地 2026-11-08 12:00
const today = (offsetMin = 0) => {
  const d = new Date(NOW)
  return d.getTime() + offsetMin * 60_000
}
const sentRow = (id, ts, extra = {}) => ({
  id: String(id), bvid: 'BV1234567890', book_id: 'book-' + id, sent: true, rpid: String(1000 + Number(String(id).replace(/\D/g, '')) || 1),
  posted_at: iso(ts), posted_ts: ts, ...extra,
})
const ledgerWith = (rows = [], extra = {}) => ({ ...emptyLedger(), posted: rows, ...extra })
const bounds = (extra = {}) => ({ ...emptyBounds(), ...extra })

test('bounds 文件读侧 fail-open：缺失/损坏/坏值都回默认（观察期 + 无 ack）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'whale-bounds-'))
  try {
    assert.equal(boundsFileOf(dir), join(dir, 'whale-bounds.json'))
    assert.deepEqual(readBounds(dir), emptyBounds())
    writeFileSync(join(dir, 'whale-bounds.json'), '{not json')
    assert.deepEqual(readBounds(dir), emptyBounds())
    assert.deepEqual(normalizeBounds({ phase: 'stable', dailyCap: 5, stopAck: '2026-11-08T01:00:00.000Z', speedAck: 'x' }), {
      phase: 'stable', dailyCap: 5, stopAck: '2026-11-08T01:00:00.000Z', speedAck: '', note: '',
    })
    assert.deepEqual(normalizeBounds({ phase: 'wat', dailyCap: 99 }), emptyBounds())
    assert.deepEqual(normalizeBounds(null), emptyBounds())
    mkdirSync(join(dir, 'nested'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('每日上限：观察期 3 / 稳定期 5 / bounds 覆盖 / 恢复档与降速都压到 1；只数当天 sent 行', () => {
  const rows = [sentRow(1, today(0)), sentRow(2, today(-60)), sentRow(3, today(-24 * 60 - 10)), sentRow(4, today(-30), { sent: false })]
  const ledger = ledgerWith(rows)
  assert.equal(sentRows(ledger).length, 3, 'sent=false 不算')
  assert.equal(sentOnDay(ledger, '2026-11-08').length, 2, '跨天不数')
  assert.equal(sentCount(ledger), 3)

  const cap = dailyCapState(ledger, bounds(), NOW)
  assert.deepEqual({ phase: cap.phase, cap: cap.cap, sent: cap.sent, reached: cap.reached }, { phase: 'observation', cap: OBSERVATION_CAP, sent: 2, reached: false })
  const threeToday = [sentRow(5, today(0)), sentRow(6, today(-5)), sentRow(7, today(-10))]
  assert.equal(dailyCapState(ledgerWith(threeToday), bounds(), NOW).reached, true, '观察期第 3 条后达限')
  assert.equal(dailyCapState(ledger, bounds({ phase: 'stable' }), NOW).cap, STABLE_CAP)
  assert.equal(dailyCapState(ledger, bounds({ phase: 'stable', dailyCap: 2 }), NOW).cap, 2, 'bounds.dailyCap 优先')
  assert.equal(dailyCapState(ledgerWith(rows, { recovery: { status: 'pending', day: '2026-11-08' } }), bounds({ phase: 'stable' }), NOW).cap, 1, '恢复档 1 条/天')
  assert.equal(dailyCapState(ledgerWith(rows, { speed: { downgraded: true } }), bounds({ phase: 'stable' }), NOW).cap, 1, '降速 1 条/天')
  assert.equal(firstReviewOpen(ledger), false)
  assert.equal(firstReviewOpen(ledgerWith(rows.slice(0, 2))), true, '首 ' + FIRST_REVIEW_COUNT + ' 条（<3）需人工批准')
})

test('停损状态机：active / 停满待人工签 / 停满且已签；ack 必须晚于停损起点', () => {
  const since = today(-60 * 60_000)
  const base = { level: 'L1', reason: 'risk-code', since: iso(since), since_ts: since, until: iso(today(23 * 3600_000)), until_ts: today(23 * 3600_000), cleared_at: '' }
  const active = stopState(ledgerWith([], { stop: base }), bounds(), NOW)
  assert.deepEqual([active.active, active.expired, active.needsAck], [true, false, false])
  assert.equal(openStopRecord(ledgerWith([], { stop: base }))?.reason, 'risk-code')
  assert.equal(openStopRecord(ledgerWith([], { stop: { ...base, cleared_at: iso(NOW) } })), null, '清除过的不算未清除')

  const expiredStop = { ...base, until: iso(today(-1)), until_ts: today(-1) }
  assert.deepEqual([stopState(ledgerWith([], { stop: expiredStop }), bounds(), NOW).needsAck], [true], '停满未签')
  assert.equal(stopState(ledgerWith([], { stop: expiredStop }), bounds({ stopAck: iso(since - 60_000) }), NOW).needsAck, true, '旧 ack（早于停损起点）不算')
  const acked = stopState(ledgerWith([], { stop: expiredStop }), bounds({ stopAck: iso(today(-30)) }), NOW)
  assert.deepEqual([acked.expired, acked.needsAck, acked.acked], [true, false, true])
  assert.equal(stopState(emptyLedger(), bounds(), NOW).active, false)
  assert.deepEqual(stopUntilOf('L1', NOW), { until: iso(NOW + 24 * 3600_000), until_ts: NOW + 24 * 3600_000 })
  assert.equal(stopUntilOf('L0', NOW).until_ts, endOfLocalDay(NOW), 'L0 停到当日结束')
  assert.ok(stopUntilOf('L2', NOW).until_ts > stopUntilOf('L1', NOW).until_ts)
})

test('止损判定：风控码/unknown/12014/render-error/连败 3 次各触发对应档；pace/质量拦不算失败', () => {
  const ev = (code, ts = today(-10), detail = '') => ({ code, ts, at: iso(ts), detail })
  assert.deepEqual(evaluateStop(ledgerWith([], { events: [ev('send-rejected:-352')] }), NOW)?.level, 'L1')
  assert.equal(evaluateStop(ledgerWith([], { events: [ev('send-rejected:12014')] }), NOW)?.level, 'L0')
  assert.equal(evaluateStop(ledgerWith([], { events: [ev('render-error')] }), NOW)?.level, 'L0')
  assert.equal(evaluateStop(ledgerWith([], { events: [ev('send-unknown')] }), NOW)?.reason, 'send-unknown')
  // detail 里带风控码（send-rejected 泛化码 + 真实错误文本）
  assert.equal(evaluateStop(ledgerWith([], { events: [ev('send-rejected', today(-10), 'code=-412 请求被拦截')] }), NOW)?.level, 'L1')
  // 连败 3 次（计数由 withSendOutcome 维护）
  assert.equal(evaluateStop(ledgerWith([], { events: [], fail_streak: 3 }), NOW)?.reason, 'consecutive-failures')
  assert.equal(evaluateStop(ledgerWith([], { events: [ev('pace-blocked'), ev('hook-invalid')] }), NOW), null, 'pace/质量拦不算发送失败')
  // 已有未清除停损 ⇒ 不重复触发
  assert.equal(evaluateStop(ledgerWith([], { stop: { level: 'L1', reason: 'risk-code', since: iso(today(-10)), since_ts: today(-10), until: iso(today(10 ** 5)), until_ts: today(10 ** 5), cleared_at: '' }, events: [ev('send-unknown')] }), NOW), null)
  // 清过账的旧信号不再触发（除非又出现新信号）
  const cleared = { level: 'L1', reason: 'risk-code', cleared_at: iso(today(-5)), cleared_ts: today(-5) }
  assert.equal(evaluateStop(ledgerWith([], { stop: cleared, events: [ev('send-unknown', today(-60))] }), NOW), null)
  assert.equal(evaluateStop(ledgerWith([], { stop: cleared, events: [ev('send-unknown', today(-1))] }), NOW)?.level, 'L1')
})

test('止损升档：同类信号再犯升一档（封顶 L3）；DOM hidden 走 L2/L3，同书/同 UP 二次 hidden 升 L3', () => {
  assert.equal(escalateStopLevel('L1', null), 'L1')
  assert.equal(escalateStopLevel('L1', { level: 'L1' }), 'L2')
  assert.equal(escalateStopLevel('L1', { level: 'L3' }), 'L3')
  const cleared = { level: 'L1', reason: 'risk-code', cleared_at: iso(today(-5)), cleared_ts: today(-5) }
  const again = evaluateStop(ledgerWith([], { stop: cleared, events: [{ code: 'send-rejected:-509', ts: today(-1), at: iso(today(-1)), detail: '' }] }), NOW)
  assert.deepEqual([again.level, again.reason, again.escalated], ['L2', 'risk-code', true])

  const visible = sentRow(1, today(-60), { v2_dom: { status: 'visible' } })
  const hidden = sentRow(2, today(-30), { v2_dom: { status: 'hidden' } })
  const manyVisible = Array.from({ length: 9 }, (_, i) => sentRow(30 + i, today(-200 + i), { v2_dom: { status: 'visible' } }))
  assert.equal(evaluateStop(ledgerWith([...manyVisible, hidden]), NOW)?.level, 'L2', '1 条 hidden（占已发 10%）⇒ L2')
  assert.equal(evaluateStop(ledgerWith([visible, hidden, sentRow(3, today(-20), { v2_dom: { status: 'hidden' } })]), NOW)?.level, 'L3', '≥2 条 hidden ⇒ L3')
  // 20% 判据
  const many = [hidden]
  for (let i = 0; i < 4; i++) many.push(sentRow(10 + i, today(-90 + i), { v2_dom: { status: 'visible' } }))
  assert.equal(evaluateStop(ledgerWith(many), NOW)?.level, 'L3', 'hidden ≥ 已发 20% ⇒ L3')
  // 同书二次 hidden
  const sameBook = [sentRow(21, today(-50), { book_id: 'same', v2_dom: { status: 'hidden' } }), sentRow(22, today(-40), { book_id: 'same', v2_dom: { status: 'hidden' } })]
  const dom = domHiddenStats(sameBook)
  assert.deepEqual([dom.total, dom.sameKey], [2, 2])
  assert.equal(evaluateStop(ledgerWith(sameBook), NOW)?.reason, 'dom-hidden')
})

test('降速判定：连续 2 次 unknown 或最近 2 条 V1 全 miss/invisible；有 hit 不算', () => {
  assert.equal(evaluateSpeed(ledgerWith([], { unknown_streak: 2 }))?.reason, 'unknown-streak')
  const miss = (id, ts) => sentRow(id, ts, { v1_30min: { status: 'miss' } })
  const inv = (id, ts) => sentRow(id, ts, { v1_24h: { status: 'invisible' } })
  const hit = (id, ts) => sentRow(id, ts, { v1_30min: { status: 'hit' } })
  assert.equal(evaluateSpeed(ledgerWith([miss(1, today(-60)), inv(2, today(-30))]))?.reason, 'v1-unverified')
  assert.equal(evaluateSpeed(ledgerWith([miss(1, today(-60)), hit(2, today(-30))])), null, '最近一条命中不算')
  assert.equal(evaluateSpeed(ledgerWith([miss(1, today(-60))])), null, '不足 2 条不判')
  assert.equal(evaluateSpeed(ledgerWith([miss(1, today(-60)), inv(2, today(-30))], { speed: { downgraded: true } })), null, '已降速不重复')
})

test('报警不停跑：no-hook 连续 3 次 / 官腔 warn 连续 5 条，各只报一次；断链后重新计数', () => {
  const ev = (code) => ({ code, ts: today(-10), at: iso(today(-10)), detail: '' })
  const alerts = evaluateAlerts(ledgerWith([], { events: [ev('no-hook'), ev('no-hook'), ev('no-hook')] }))
  assert.deepEqual(alerts.map((a) => a.code), ['alert:no-hook'])
  assert.deepEqual(evaluateAlerts(ledgerWith([], { events: [ev('no-hook'), ev('no-hook'), ev('no-hook'), ev('alert:no-hook')] })), [], '已报过不重复')
  assert.deepEqual(evaluateAlerts(ledgerWith([], { events: [ev('no-hook'), ev('gate-miss'), ev('no-hook'), ev('no-hook')] })), [], '断链重新计数')
  const tone = Array.from({ length: 5 }, () => ev('tone-warn'))
  assert.deepEqual(evaluateAlerts(ledgerWith([], { events: tone })).map((a) => a.code), ['alert:tone-warn'])
})

test('恢复档结算：waiting / ok（V1 24h hit）/ unverified', () => {
  const recovery = { status: 'pending', day: '2026-11-08', started_at: iso(today(-120)) }
  assert.equal(recoveryVerdict(ledgerWith([], { recovery }))?.status, 'waiting')
  const row = sentRow(1, today(-60), { v1_24h: { status: 'hit' } })
  assert.equal(recoveryVerdict(ledgerWith([row], { recovery }))?.status, 'ok')
  const miss = sentRow(1, today(-60), { v1_24h: { status: 'miss' } })
  assert.equal(recoveryVerdict(ledgerWith([miss], { recovery }))?.status, 'unverified')
  assert.equal(recoveryRecord(ledgerWith([], { recovery: { status: 'ok' } })), null, '已结算不算 pending')
})

test('ledger 运行边界落账：停损/清除/恢复/降速/连败计数/DOM 槽，且 capLedger 不动这些字段', () => {
  let ledger = emptyLedger()
  ledger = withSendOutcome(ledger, { ok: false, fail: true, unknown: true })
  ledger = withSendOutcome(ledger, { ok: false, fail: true, unknown: true })
  assert.deepEqual([ledger.fail_streak, ledger.unknown_streak], [2, 2])
  ledger = withSendOutcome(ledger, { ok: false, fail: true })
  assert.deepEqual([ledger.fail_streak, ledger.unknown_streak], [3, 0], '非 unknown 失败重置 unknown 连计')
  ledger = withSendOutcome(ledger, { ok: false, fail: false })
  assert.deepEqual([ledger.fail_streak, ledger.unknown_streak], [3, 0], 'pace/质量拦不动计数')
  ledger = withSendOutcome(ledger, { ok: true })
  assert.deepEqual([ledger.fail_streak, ledger.unknown_streak], [0, 0])

  ledger = { ...ledger, posted: [sentRow(1, today(-30))] }
  ledger = withStop(ledger, { level: 'L1', reason: 'risk-code', until: iso(today(10 ** 5)), until_ts: today(10 ** 5) })
  assert.equal(openStopRecord(ledger)?.level, 'L1')
  assert.equal(ledger.fail_streak, 0, '停损落账同时清零连败计数')
  ledger = withStopCleared(ledger, { ackAt: iso(today(-1)), note: '人工核验' })
  assert.ok(ledger.stop.cleared_at)
  assert.equal(openStopRecord(ledger), null)
  assert.equal(ledger.stop.cleared_ts > 0, true)

  ledger = withRecovery(ledger, { day: '2026-11-08' })
  assert.equal(recoveryRecord(ledger)?.status, 'pending')
  ledger = withRecoveryResult(ledger, { status: 'ok' })
  assert.equal(ledger.recovery.status, 'ok')
  assert.equal(recoveryRecord(ledger), null)

  ledger = withSpeed(ledger, { reason: 'v1-unverified' })
  assert.equal(ledger.speed.downgraded, true)
  ledger = withSpeed(ledger, { reason: 'again' })
  assert.equal(ledger.speed.reason, 'v1-unverified', '已有降速不覆盖起点')
  ledger = withSpeedCleared(ledger, { note: '人工复核' })
  assert.equal(ledger.speed.downgraded, false)

  ledger = withDomResult(ledger, '1', { status: 'hidden', how: 'dom' })
  assert.equal(ledger.posted[0].v2_dom.status, 'hidden')
  const capped = capLedger({ ...ledger, events: Array.from({ length: 5 }, () => ({ code: 'no-hook', ts: 1 })) })
  assert.equal(capped.speed.downgraded, false, 'capLedger 保留 speed')
  assert.equal(sentRowsOf(capped).length, 1)
})
