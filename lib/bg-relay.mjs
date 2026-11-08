/**
 * lib/bg-relay.mjs —— 后台轮「提前收工自动接力」的调度判据（纯函数，可离线单测）
 * ============================================================================
 * 起因：#1725。接力原实现是「setTimeout 2.5s 后调一次 runDuty」，且**不看返回值**——
 * runDuty 在槽被占时返回 { started:false, busy:true }（正常返回、不抛错），接力于是静默放弃；
 * 而学习审核轮（learn-review:auto）每 15 秒的 tick 可能刚好在接力定时的 2.5 秒里抢到同一个
 * headless 槽，抢到之后又没人把 pet 窗口拉回来 ⇒ 无人值守长窗口静默缩水（2026-11-08 实测两次：
 * 承诺「剩余 84/88 分钟」后窗口直接结束）。
 *
 * 本模块只回答「下一步该等多久 / 重试 / 放弃」，真正的 spawn、日志与槽释放钩子在 index.js：
 *   · planRelayAttempt   —— 一次接力尝试之后怎么排下一次（首次 2.5s；被占则 5s/15s/30s 退避）
 *   · shouldResumeOnSlotFree —— 后台子进程退出（槽释放）时，要不要立刻把待接力窗口拉起来
 *   · relayRemainingMs   —— 剩余窗口时间的唯一算法（负数归零，别把 NaN 当时间）
 */

/** 剩余不足 2 分钟就不值得再开一轮（与 runDuty 的 willContinue 同口径） */
export const RELAY_MIN_REMAIN_MS = 120_000
/** 首次接力的等待：留 2.5 秒给子进程收尾/管道排空（沿用原实现） */
export const RELAY_FIRST_DELAY_MS = 2_500
/** 槽被占时的退避序列（封顶后一直用最后一个） */
export const RELAY_RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000])

/** 窗口剩余毫秒（<=0 或坏值一律 0） */
export const relayRemainingMs = (deadlineAt, now = Date.now()) => {
  const remain = Number(deadlineAt) - Number(now)
  return Number.isFinite(remain) && remain > 0 ? remain : 0
}

/**
 * 接力下一步动作：
 *  - { action: 'start', delayMs }：槽空着 ⇒ delayMs 后开跑（首次 2.5s；重试时就地开跑 0s）
 *  - { action: 'retry', delayMs }：槽被占（学习审核轮等）⇒ delayMs 后再试
 *  - { action: 'give-up', reason }：no-time（窗口不足 2 分钟）/ slot-stuck（退避完也不够时间）
 * @param {{ attempts?: number, slotBusy?: boolean, remainingMs?: number, minRemainMs?: number }} state
 *   attempts = 之前已经重试过几次（首次尝试传 0）
 */
export const planRelayAttempt = ({ attempts = 0, slotBusy = false, remainingMs = 0, minRemainMs = RELAY_MIN_REMAIN_MS } = {}) => {
  const remain = Number(remainingMs) > 0 ? Number(remainingMs) : 0
  const tries = Math.max(0, Math.floor(Number(attempts) || 0))
  const floor = Number(minRemainMs) > 0 ? Number(minRemainMs) : RELAY_MIN_REMAIN_MS
  if (remain < floor) return { action: 'give-up', reason: 'no-time', delayMs: 0 }
  if (!slotBusy) return { action: 'start', delayMs: tries === 0 ? RELAY_FIRST_DELAY_MS : 0 }
  const delayMs = RELAY_RETRY_DELAYS_MS[Math.min(tries, RELAY_RETRY_DELAYS_MS.length - 1)]
  if (remain - delayMs < floor) return { action: 'give-up', reason: 'slot-stuck', delayMs }
  return { action: 'retry', delayMs }
}

/**
 * 槽释放（任意后台子进程退出）时，要不要立刻恢复待接力的窗口：
 * 有 queue、槽已空、且时间还够 —— 三条同时成立才恢复；否则交给原定 timer 或放弃。
 */
export const shouldResumeOnSlotFree = ({ pending = false, childStillRunning = false, remainingMs = 0, minRemainMs = RELAY_MIN_REMAIN_MS } = {}) => {
  if (!pending || childStillRunning) return false
  const remain = Number(remainingMs) > 0 ? Number(remainingMs) : 0
  return remain >= (Number(minRemainMs) > 0 ? Number(minRemainMs) : RELAY_MIN_REMAIN_MS)
}
