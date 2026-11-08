import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RELAY_MIN_REMAIN_MS, RELAY_FIRST_DELAY_MS, RELAY_RETRY_DELAYS_MS,
  relayRemainingMs, planRelayAttempt, shouldResumeOnSlotFree,
} from '../lib/bg-relay.mjs'

test('relayRemainingMs：正常/过期/坏值都归一成非负毫秒', () => {
  assert.equal(relayRemainingMs(1_000_000, 1_000_000 - 90_000), 90_000)
  assert.equal(relayRemainingMs(1_000_000, 1_000_001), 0)
  assert.equal(relayRemainingMs(0, 1), 0)
  assert.equal(relayRemainingMs('bad', 1), 0)
  assert.equal(relayRemainingMs(undefined, undefined), 0)
})

test('planRelayAttempt：槽空 ⇒ 首次等 2.5 秒后开跑（与原实现同节奏）', () => {
  assert.deepEqual(planRelayAttempt({ attempts: 0, slotBusy: false, remainingMs: 10 * 60_000 }), { action: 'start', delayMs: 2_500 })
  assert.equal(RELAY_FIRST_DELAY_MS, 2_500)
})

test('planRelayAttempt：重试且槽已空 ⇒ 就地开跑（不再等 2.5 秒）', () => {
  assert.deepEqual(planRelayAttempt({ attempts: 3, slotBusy: false, remainingMs: 10 * 60_000 }), { action: 'start', delayMs: 0 })
})

test('planRelayAttempt：槽被占 ⇒ 5s/15s/30s 退避并封顶（#1725 的核心）', () => {
  const remain = 60 * 60_000
  assert.deepEqual(planRelayAttempt({ attempts: 0, slotBusy: true, remainingMs: remain }), { action: 'retry', delayMs: 5_000 })
  assert.deepEqual(planRelayAttempt({ attempts: 1, slotBusy: true, remainingMs: remain }), { action: 'retry', delayMs: 15_000 })
  assert.deepEqual(planRelayAttempt({ attempts: 2, slotBusy: true, remainingMs: remain }), { action: 'retry', delayMs: 30_000 })
  assert.deepEqual(planRelayAttempt({ attempts: 99, slotBusy: true, remainingMs: remain }), { action: 'retry', delayMs: 30_000 })
  assert.deepEqual([...RELAY_RETRY_DELAYS_MS], [5_000, 15_000, 30_000])
})

test('planRelayAttempt：剩余不足 2 分钟 ⇒ 直接放弃（no-time）', () => {
  assert.equal(RELAY_MIN_REMAIN_MS, 120_000)
  assert.deepEqual(planRelayAttempt({ attempts: 0, slotBusy: false, remainingMs: 119_999 }), { action: 'give-up', reason: 'no-time', delayMs: 0 })
  assert.equal(planRelayAttempt({ attempts: 0, slotBusy: true, remainingMs: 0 }).action, 'give-up')
})

test('planRelayAttempt：退避一次之后就不够时间 ⇒ 放弃（slot-stuck，不空转）', () => {
  // 剩 140s：已重试 2 次 ⇒ 下一档 30s，140-30 < 120 ⇒ 放弃
  assert.deepEqual(planRelayAttempt({ attempts: 2, slotBusy: true, remainingMs: 140_000 }), { action: 'give-up', reason: 'slot-stuck', delayMs: 30_000 })
  // 剩 150s 但只重试 0 次 ⇒ 5s 退避后还剩 145s，够 ⇒ 继续重试
  assert.deepEqual(planRelayAttempt({ attempts: 0, slotBusy: true, remainingMs: 150_000 }), { action: 'retry', delayMs: 5_000 })
})

test('shouldResumeOnSlotFree：有队、槽空、时间够 才恢复', () => {
  assert.equal(shouldResumeOnSlotFree({ pending: true, childStillRunning: false, remainingMs: 10 * 60_000 }), true)
  assert.equal(shouldResumeOnSlotFree({ pending: false, childStillRunning: false, remainingMs: 10 * 60_000 }), false, '没有待接力窗口')
  assert.equal(shouldResumeOnSlotFree({ pending: true, childStillRunning: true, remainingMs: 10 * 60_000 }), false, '槽还占着')
  assert.equal(shouldResumeOnSlotFree({ pending: true, childStillRunning: false, remainingMs: 60_000 }), false, '不足 2 分钟不恢复')
  assert.equal(shouldResumeOnSlotFree({ pending: true, remainingMs: 'bad' }), false)
})