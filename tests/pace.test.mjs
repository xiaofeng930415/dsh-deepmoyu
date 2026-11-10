import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BURST, PACE, PACE_KINDS, PACE_PRESETS, QUOTA_CODES, QUOTA_SCOPES, RISK_COOLDOWN,
  nextQuotaReset, paceBook, paceCheck, paceExplain, paceNoteRisk, paceSummary, paceTake,
} from '../lib/pace.mjs'

const MIN = 60_000
const NOW = new Date(2026, 9, 28, 12, 0, 0).getTime()

// Match the host's existing paceDone policy without mutating the supplied book.
const takeWithFactor = (book, kind, now, factor, rand = 0.5) => {
  const next = paceTake(book, kind, now, rand)
  next.last[kind].next = now + Math.round((next.last[kind].next - now) * factor)
  return next
}

const frozen = (value) => {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') frozen(child)
  }
  return Object.freeze(value)
}

test('pace presets are explicit opt-in interval preferences, not a new saved default', () => {
  assert.deepEqual(PACE_PRESETS, { normal: 1, responsive: 0.5, cautious: 1.5 })
  assert.equal(Object.isFrozen(PACE_PRESETS), true)
  const info = paceExplain(null, NOW)
  assert.equal(info.factor, 1)
  assert.deepEqual(info.presets, PACE_PRESETS)
  assert.equal(info.factorAffects, 'next-success-gap-only')
  assert.equal(info.pinnedIntervalsPreserved, true)
  assert.match(info.notes.safety, /不是 B站.*安全频率/)
  assert.match(info.notes.safety, /不会自动覆盖/)
})

test('paceExplain describes base and effective intervals for every preset and kind', () => {
  for (const factor of Object.values(PACE_PRESETS)) {
    const info = paceExplain(null, NOW, factor)
    assert.deepEqual(Object.keys(info.kinds), PACE_KINDS)
    for (const kind of PACE_KINDS) {
      const spec = PACE[kind]
      const row = info.kinds[kind]
      assert.equal(row.baseGapSec, spec.gap / 1000)
      assert.equal(row.baseJitterSec, spec.jitter / 1000)
      assert.equal(row.baseMinSec, spec.gap / 1000)
      assert.equal(row.baseMaxSec, (spec.gap + spec.jitter) / 1000)
      assert.equal(row.effectiveGapSec, Math.round(spec.gap * factor) / 1000)
      assert.equal(row.effectiveJitterSec, Math.round(spec.jitter * factor) / 1000)
      assert.equal(row.effectiveMinSec, row.effectiveGapSec)
      assert.equal(row.effectiveMaxSec, Math.round((spec.gap + spec.jitter) * factor) / 1000)
      assert.equal(row.hourCap, spec.hour)
      assert.equal(row.hourWindowSec, 3600)
      assert.equal(row.hourCapScalesWithFactor, false)
      assert.equal(row.usedThisHour, 0)
      assert.equal(row.waitSec, 0)
      assert.equal(row.nextAt, '')
    }
  }
  const fast = paceExplain(null, NOW, PACE_PRESETS.responsive)
  assert.deepEqual([fast.kinds.comment.effectiveMinSec, fast.kinds.comment.effectiveMaxSec], [60, 90])
  assert.deepEqual([fast.kinds.opusReply.effectiveMinSec, fast.kinds.opusReply.effectiveMaxSec], [10, 15])
  assert.deepEqual([fast.kinds.dm.effectiveMinSec, fast.kinds.dm.effectiveMaxSec], [15, 22.5])
})

test('paceExplain uses the existing factor bounds without quantizing custom factors', () => {
  for (const [raw, expected] of [[0.1, 0.3], [4, 3], ['0.73', 0.73], ['bad', 1], [Infinity, 1]]) {
    const info = paceExplain(null, NOW, raw)
    assert.equal(info.factor, expected)
    assert.equal(info.kinds.reply.effectiveMinSec, 60 * expected)
  }
  assert.equal(paceExplain(null, NOW, 0.73).kinds.dm.effectiveJitterSec, 10.95)
})

test('changing a description factor cannot shorten or lengthen an already pinned interval', () => {
  const book = frozen(takeWithFactor(null, 'comment', NOW, PACE_PRESETS.cautious, 1))
  const before = JSON.stringify(book)
  for (const factor of [0.3, 0.5, 1, 1.5, 3]) {
    const info = paceExplain(book, NOW + 10_000, factor)
    assert.equal(info.kinds.comment.waitSec, 260)
    assert.equal(info.kinds.comment.nextAt, new Date(NOW + 270_000).toISOString())
    assert.equal(info.kinds.comment.blockedBy, 'gap')
    assert.equal(paceCheck(book, 'comment', NOW + 10_000).retryAt, NOW + 270_000)
  }
  assert.equal(JSON.stringify(book), before)
  assert.equal(paceCheck(book, 'comment', NOW + 270_000).ok, true)
})

test('descriptive interval endpoints match the existing host pinning at each preset', () => {
  for (const factor of Object.values(PACE_PRESETS)) {
    for (const kind of PACE_KINDS) {
      const row = paceExplain(null, NOW, factor).kinds[kind]
      const first = takeWithFactor(null, kind, NOW, factor, 0)
      const last = takeWithFactor(null, kind, NOW, factor, 1)
      assert.equal((first.last[kind].next - NOW) / 1000, row.effectiveMinSec)
      assert.equal((last.last[kind].next - NOW) / 1000, row.effectiveMaxSec)
    }
  }
})

test('hourly caps remain rolling and may dominate an apparently short interval', () => {
  for (const kind of PACE_KINDS) {
    const cap = PACE[kind].hour
    const book = paceBook({ recent: Array.from({ length: cap }, (_, i) => ({ k: kind, t: NOW - 20 * MIN + i * 1000 })) })
    const info = paceExplain(book, NOW, PACE_PRESETS.responsive).kinds[kind]
    assert.equal(info.hourCap, cap)
    assert.equal(info.usedThisHour, cap)
    assert.equal(info.waitSec, 40 * 60)
    assert.equal(info.blockedBy, 'hour')
    assert.equal(paceCheck(book, kind, NOW).reason, 'hour')
    assert.equal(paceCheck(book, kind, NOW + 40 * MIN).ok, true)
  }
})

test('rolling burst policy combines all send kinds and is unchanged by presets', () => {
  const book = paceBook({ recent: Array.from({ length: BURST.max }, (_, i) => ({ k: PACE_KINDS[i % PACE_KINDS.length], t: NOW - 30_000 })) })
  for (const factor of Object.values(PACE_PRESETS)) {
    const info = paceExplain(book, NOW, factor)
    assert.equal(info.burst.windowSec, 600)
    assert.equal(info.burst.max, 10)
    assert.equal(info.burst.used, 10)
    assert.equal(info.burst.scope, 'all')
    assert.equal(info.burst.scalesWithFactor, false)
    assert.equal(info.burst.extraWaitSec, 180)
    assert.equal(info.burst.extraAfterCount, 13)
    for (const kind of PACE_KINDS) {
      assert.equal(info.kinds[kind].blockedBy, 'burst')
      // A dynamic may also hit the stricter one-per-hour cap.
      assert.ok(info.kinds[kind].waitSec >= 570)
      assert.equal(paceCheck(book, kind, NOW).reason, 'burst')
    }
  }
})

test('combined gates report the latest retry while preserving hard-gate priority and channel scope', () => {
  const hourLimited = { recent: Array.from({ length: 8 }, (_, i) => ({ k: 'comment', t: NOW - 10 * MIN + i * 1000 })) }
  const scenarios = [
    { book: { ...hourLimited, cooldownUntil: NOW + MIN }, kind: 'comment', reason: 'cooldown', wait: 50 * MIN },
    { book: { ...hourLimited, quota: { comment: NOW + 5 * MIN } }, kind: 'comment', reason: 'quota', wait: 50 * MIN },
    { book: { recent: Array.from({ length: BURST.max }, () => ({ k: 'reply', t: NOW - 30_000 })), last: { dm: { at: NOW - 1000, next: NOW + 15 * MIN } } }, kind: 'dm', reason: 'burst', wait: 15 * MIN },
    { book: { ...hourLimited, last: { comment: { at: NOW - 1000, next: NOW + 55 * MIN } } }, kind: 'comment', reason: 'hour', wait: 55 * MIN },
  ]
  for (const { book, kind, reason, wait } of scenarios) {
    const input = frozen(book), before = JSON.stringify(input)
    const check = paceCheck(input, kind, NOW), row = paceSummary(input, NOW).kinds[kind]
    assert.equal(check.reason, reason)
    assert.equal(check.waitMs, wait)
    assert.equal(check.retryAt, NOW + wait)
    assert.equal(row.blockedBy, reason)
    assert.equal(row.waitSec, Math.ceil(check.waitMs / 1000))
    assert.equal(row.nextAt, new Date(check.retryAt).toISOString())
    assert.match(check.hint, /其他节奏限制/)
    assert.equal(paceCheck(input, kind, check.retryAt).ok, true)
    assert.equal(JSON.stringify(input), before)
  }
  const quota = scenarios[1].book
  for (const kind of ['opusReply', 'dm', 'moment']) assert.equal(paceCheck(quota, kind, NOW).ok, true)
  for (const kind of PACE_KINDS) assert.equal(paceCheck(scenarios[0].book, kind, NOW).reason, 'cooldown')
})

test('quota explanation keeps 12014 scoped to video comment/reply and preserves parking', () => {
  let book = null
  for (const expectedMin of [45, 90, 180, 180]) {
    book = paceNoteRisk(book, 12014, NOW).book
    const info = paceExplain(book, NOW, PACE_PRESETS.responsive)
    assert.equal(info.quota.scalesWithFactor, false)
    assert.deepEqual(info.quota.scopes, { comment: ['comment', 'reply'], dm: ['dm'] })
    assert.deepEqual(info.quota.parkSec, [2700, 5400, 10800])
    assert.equal(info.quota.maxParkSec, 10800)
    assert.equal(info.quota.strikeDecaySec, 7200)
    assert.equal(info.quota.active.comment.waitSec, expectedMin * 60)
    assert.equal(info.quota.active.dm, undefined)
    assert.equal(info.risk.active, null)
    for (const kind of PACE_KINDS) {
      const affected = kind === 'comment' || kind === 'reply'
      assert.equal(info.kinds[kind].quotaBucket, affected ? 'comment' : kind === 'dm' ? 'dm' : '')
      assert.equal(info.kinds[kind].blockedBy, affected ? 'quota' : '')
      assert.equal(paceCheck(book, kind, NOW).ok, !affected)
    }
  }
  const nearMidnight = new Date(2026, 9, 28, 23, 59).getTime()
  const parked = paceNoteRisk(null, 12014, nearMidnight).book
  assert.equal(parked.quota.comment, nextQuotaReset(nearMidnight))
  assert.equal(paceExplain(parked, nearMidnight, 0.3).quota.active.comment.waitSec, 6 * 60)
})

test('dm codes park only dm, and 21046 parks for 24h without spilling into comments (spec #1751 E)', () => {
  // 21046：平台原话"请在24小时后再发" ⇒ dm 桶停到 00:05 天花板为止（最长 24h），
  //   评论/回复/动态一条不受影响。⚠️ 天花板是本地 00:05：NOW=12:00 ⇒ 剩 12h25m，不是整 24h。
  const book = paceNoteRisk(null, '21046', NOW).book
  assert.equal(book.quota.dm, nextQuotaReset(NOW))
  assert.equal(book.quota.comment, undefined)
  assert.equal(book.cooldownUntil, 0)
  const info = paceExplain(book, NOW, PACE_PRESETS.responsive)
  assert.equal(info.risk.active, null)
  assert.equal(info.quota.active.dm.waitSec, (nextQuotaReset(NOW) - NOW) / 1000)
  assert.equal(info.quota.active.comment, undefined)
  for (const kind of PACE_KINDS) {
    const affected = kind === 'dm'
    assert.equal(paceCheck(book, kind, NOW).ok, !affected)
    // 未被 dm 桶管住的 kind：reason 为 undefined（paceCheck 只在被拦时才填）
    assert.equal(paceCheck(book, kind, NOW).reason, affected ? 'quota' : undefined)
  }
  // 21020 / 21015 / 25003 同一个 dm 桶；同样停到 00:05 天花板（平台显式禁令，不做 45→90→180 递增）
  for (const code of ['21020', '21015', '25003']) {
    const first = paceNoteRisk(null, code, NOW).book
    assert.equal(first.quota.dm, nextQuotaReset(NOW))
    assert.equal(first.cooldownUntil, 0)
    assert.equal(paceCheck(first, 'comment', NOW).ok, true)
    assert.equal(paceCheck(first, 'dm', NOW).ok, false)
  }
})

test('21047 relationship gate is deliberately absent from cooldown and quota tables', () => {
  // 关系门不是风控也不是额度：宿主在 dm 发送链里单独判（不重试、换下一个人）。
  // 这里钉住"两张表里都没有它"，防止后来者顺手把它加进去把正常业务结果变成停牌。
  assert.equal(QUOTA_CODES['21047'], undefined)
  assert.equal(RISK_COOLDOWN['21047'], undefined)
  const book = paceNoteRisk(null, '21047', NOW).book
  assert.equal(book.cooldownUntil, 0)
  assert.deepEqual(book.quota, {})
  assert.equal(paceCheck(book, 'dm', NOW).ok, true)
})

test('risk cooldown descriptions remain global, unscaled, and cannot reduce an existing cooldown', () => {
  for (const [code, ms] of Object.entries(RISK_COOLDOWN)) {
    const book = paceNoteRisk(null, code, NOW).book
    for (const factor of Object.values(PACE_PRESETS)) {
      const info = paceExplain(book, NOW, factor)
      assert.equal(info.risk.scope, 'all')
      assert.equal(info.risk.scalesWithFactor, false)
      assert.equal(info.risk.cooldownSecByCode[code], ms / 1000)
      assert.equal(info.risk.active.waitSec, ms / 1000)
      for (const kind of PACE_KINDS) {
        assert.equal(info.kinds[kind].blockedBy, 'cooldown')
        assert.equal(info.kinds[kind].waitSec, ms / 1000)
        assert.equal(paceCheck(book, kind, NOW).reason, 'cooldown')
      }
    }
  }
  const long = paceNoteRisk(null, -412, NOW).book
  const short = paceNoteRisk(long, -352, NOW + MIN).book
  assert.equal(short.cooldownUntil, long.cooldownUntil)
  assert.equal(paceExplain(short, NOW + MIN, 0.3).risk.active.waitSec, 59 * 60)
})

test('explanations are detached, read-only snapshots and retain real summary waits', () => {
  const book = frozen(paceNoteRisk(takeWithFactor(null, 'comment', NOW, 1), 12014, NOW).book)
  const before = JSON.stringify(book)
  const info = paceExplain(book, NOW, 0.5)
  const summary = paceSummary(book, NOW, 0.5)
  for (const kind of PACE_KINDS) {
    for (const key of ['waitSec', 'nextAt', 'blockedBy', 'hourCap', 'usedThisHour']) {
      assert.equal(info.kinds[kind][key], summary.kinds[kind][key])
    }
  }
  info.presets.normal = 7
  info.quota.scopes.comment.push('dm')
  info.quota.active.comment.kinds.push('moment')
  info.quota.codes['12014'] = 'dm'
  info.risk.cooldownSecByCode['-352'] = 1
  assert.deepEqual(PACE_PRESETS, { normal: 1, responsive: 0.5, cautious: 1.5 })
  assert.deepEqual(QUOTA_SCOPES.comment, ['comment', 'reply'])
  assert.equal(RISK_COOLDOWN['-352'], 20 * MIN)
  assert.equal(JSON.stringify(book), before)
  assert.equal(paceExplain(book, NOW).quota.codes['12014'], 'comment')
})
