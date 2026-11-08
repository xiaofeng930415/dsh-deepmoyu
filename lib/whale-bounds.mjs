/**
 * lib/whale-bounds.mjs —— 鲸鱼书评线运行边界（规格 docs/spec-whale-bili-book-comment.md §9.2/§9.4/§9.5；T6）
 * ============================================================================
 * 三件事，全部是**纯函数**（宿主只做「读 → 判 → 写账/停批次」，判定可离线单测）：
 *   ① 每日上限：观察期 3 条/天、稳定期 5 条/天（本人在 whale-bounds.json 里确认升档）；
 *      停损恢复日（首日）只发 1 条；降速期 1 条/天；
 *   ② 止损矩阵：L0 停当日（12014 / render-error）、L1 停 24h（风控码 / 连续 3 次非 pace
 *      发送失败 / send-unknown）、L2 停 3 天（DOM 核验 1 条 hidden）、L3 停 7 天（hidden ≥2
 *      或 ≥已发 20%、同书/同 UP 连续 2 次 hidden）；同类信号再犯**升一档**；
 *   ③ 降速 1 条/天（不停跑）：连续 2 次 send-unknown 或最近 2 条已发全判 V1 miss/invisible；
 *      人工复核后写 bounds.speedAck 恢复。
 *
 * 数据源（与规格 §10.1 一致，不新增模型可见面）：
 *   - ledger（机器写）：posted[]（sent/posted_ts/v1_30min/v1_24h/v2_dom）+ events[] +
 *     stop/recovery/speed/fail_streak/unknown_streak（形状由 whale-ledger 定义）；
 *   - `stateDir/whale-bounds.json`（**本人维护**，与 book-focus.json 同家；模型无权改）：
 *     { phase:'observation'|'stable', dailyCap:1..5|null, stopAck:'ISO', speedAck:'ISO', note }
 *   - 人工动作只有两个：升档/改上限（phase / dailyCap）、停损恢复（停满后把 stopAck 写成
 *     当前时间）——停损是机器写的，恢复必须有人签（§9.5「停满 + 人工核验」）。
 *
 * 口径注意：V1 的 miss/invisible **只当「待复核」**，不单独判不可见（§9.5）——所以它只触发
 * 降速，不触发 L2/L3；L2/L3 只认 V2 DOM 的 hidden（v2_dom 槽，V2 由 T5c/T7 接线）。
 */
import { join } from 'node:path'
import { readJson } from './state.mjs'
import { localDayOf, sentRowsOf } from './whale-ledger.mjs'

export const WHALE_BOUNDS_NAME = 'whale-bounds.json'
export const boundsFileOf = (stateDir) => join(stateDir, WHALE_BOUNDS_NAME)

/** §9.2/§9.4：观察期 3 条/天；稳定期 5 条/天（升档由本人确认） */
export const OBSERVATION_CAP = 3
export const STABLE_CAP = 5
/** §9.3：观察期首 3 条发送走人工批准 */
export const FIRST_REVIEW_COUNT = 3

export const STOP_LEVEL_ORDER = ['L0', 'L1', 'L2', 'L3']
/** L1 24h / L2 3 天 / L3 7 天；L0 = 停到当日结束 */
export const STOP_DURATIONS_MS = Object.freeze({
  L1: 24 * 3600_000,
  L2: 3 * 24 * 3600_000,
  L3: 7 * 24 * 3600_000,
})

/** 风控码（§9.5 L1）：出现在 send-rejected 的失败码或 detail 里 */
export const RISK_CODES = Object.freeze(['-352', '-412', '-509', '-799'])
const RISK_RE = /(?:^|[^\d])-(352|412|509|799)(?!\d)/
const RISK_CODE_RE = /^send-rejected:(-352|-412|-509|-799)$/
const SEND_FAILURE_RE = /^send-(?:rejected|unknown)(?::|$)/

/** bounds 文件形状（读侧 fail-open；坏值回默认，不抛） */
export const emptyBounds = () => ({ phase: 'observation', dailyCap: null, stopAck: '', speedAck: '', note: '' })

export const normalizeBounds = (raw) => {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const phase = src.phase === 'stable' ? 'stable' : 'observation'
  const cap = Number(src.dailyCap)
  const dailyCap = Number.isInteger(cap) && cap >= 1 && cap <= STABLE_CAP ? cap : null
  const iso = (value) => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '')
  return {
    phase,
    dailyCap,
    stopAck: iso(src.stopAck),
    speedAck: iso(src.speedAck),
    note: String(src.note ?? '').slice(0, 200),
  }
}

/** 只读入口：文件缺失/损坏一律按默认（观察期、无 ack）——边界参数丢了不该把插件卡死。 */
export const readBounds = (stateDir) => normalizeBounds(readJson(boundsFileOf(stateDir), null))

/* ── 时间与发送统计 ── */
const tsOf = (value) => {
  const t = Date.parse(String(value ?? ''))
  return Number.isFinite(t) ? t : 0
}
const numOrZero = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** 本地日结束的墙钟毫秒（L0 停到当天 24:00） */
export const endOfLocalDay = (now = Date.now()) => {
  const d = new Date(Number(now) || Date.now())
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime()
}

/** 停损停到什么时候（按档位给出 until/until_ts） */
export const stopUntilOf = (level, now = Date.now()) => {
  const at = Number(now) || Date.now()
  if (level === 'L0') return { until: new Date(endOfLocalDay(at)).toISOString(), until_ts: endOfLocalDay(at) }
  const ms = STOP_DURATIONS_MS[level] || STOP_DURATIONS_MS.L1
  return { until: new Date(at + ms).toISOString(), until_ts: at + ms }
}

/** 已成功发送（有 rpid 的 posted 行）——上限与止损的统计口径 */
export const sentRows = (ledger) => sentRowsOf(ledger)

export const sentOnDay = (ledger, day) => sentRows(ledger).filter((row) => localDayOf(new Date(row.posted_ts)) === day)

export const sentCount = (ledger) => sentRows(ledger).length

/** 当前未清除的停损记录（清除过的留在账上做「同类信号再犯升档」的依据） */
export const openStopRecord = (ledger) => {
  const rec = ledger?.stop
  if (!rec || typeof rec !== 'object' || Array.isArray(rec) || rec.cleared_at) return null
  return rec
}

/** 停损状态：active=停损期；expired && needsAck=停满但没人签；expired && !needsAck=可恢复 */
export const stopState = (ledger, bounds, now = Date.now()) => {
  const record = openStopRecord(ledger)
  if (!record) return { active: false, expired: false, needsAck: false, record: null, until: '', level: '', acked: false }
  const untilTs = numOrZero(record.until_ts) || tsOf(record.until)
  const active = untilTs > now
  const sinceTs = numOrZero(record.since_ts) || tsOf(record.since)
  const ackTs = tsOf(bounds?.stopAck)
  // 「人工核验」必须晚于停损起点才算数（防旧 ack 被复用）
  const needsAck = !active && !(ackTs && ackTs >= sinceTs)
  return { active, expired: !active, needsAck, record, until: String(record.until ?? ''), level: String(record.level ?? 'L1'), acked: !needsAck }
}

/** 恢复档（停损恢复首日 1 条/天；24h 可见才回正常档）：pending 时上限按 1 算 */
export const recoveryRecord = (ledger) => {
  const rec = ledger?.recovery
  return rec && typeof rec === 'object' && !Array.isArray(rec) && rec.status === 'pending' ? rec : null
}

/** 当日上限状态（§9.2）：恢复档/降速 ⇒ 1 条/天；否则 bounds.dailyCap，再次 phase 默认值 */
export const dailyCapState = (ledger, bounds, now = Date.now()) => {
  const day = localDayOf(new Date(Number(now) || Date.now()))
  const recovery = recoveryRecord(ledger)
  const slowed = ledger?.speed?.downgraded === true
  const cap = recovery || slowed
    ? 1
    : Number.isInteger(bounds?.dailyCap)
      ? bounds.dailyCap
      : bounds?.phase === 'stable' ? STABLE_CAP : OBSERVATION_CAP
  const sent = sentOnDay(ledger, day).length
  return {
    day,
    sent,
    cap,
    left: Math.max(0, cap - sent),
    reached: sent >= cap,
    phase: bounds?.phase === 'stable' ? 'stable' : 'observation',
    recovery: Boolean(recovery),
    slowed,
  }
}

/** 首 3 条：已成功发送数 < 3 ⇒ 仍要人工批准（§9.3；与 sendReview 开关无关） */
export const firstReviewOpen = (ledger) => sentCount(ledger) < FIRST_REVIEW_COUNT

/* ── 止损矩阵（§9.5）── */
const eventList = (ledger) => (Array.isArray(ledger?.events) ? ledger.events : [])

/** 只看「上一轮停损清除之后」的事件：清过账的旧信号不再触发新停损 */
const eventsSinceClear = (ledger) => {
  const clearedTs = numOrZero(ledger?.stop?.cleared_ts)
  return eventList(ledger).slice(-80).filter((e) => numOrZero(e?.ts) > clearedTs)
}

/** V2 DOM 的 hidden 统计（v2_dom 槽由 T5c/T7 接线；没有生产者时恒空，不误判）。
 *  「同书/同 UP 连续 2 次 hidden」取**累计**口径（任意两次即算）：规格字面「连续」更严，
 *   这里保守从严——多停一次比漏停安全，且 hidden 本身要人工复核。 */
export const domHiddenStats = (rows) => {
  const sent = Array.isArray(rows) ? rows : []
  const hidden = sent.filter((row) => row?.v2_dom?.status === 'hidden')
  const byKey = new Map()
  let sameKey = 0
  for (const row of hidden) {
    const keys = [String(row.book_id ?? ''), String(row.mid ?? '')].filter(Boolean)
    for (const key of keys) {
      const n = (byKey.get(key) || 0) + 1
      byKey.set(key, n)
      if (n > sameKey) sameKey = n
    }
  }
  return { total: hidden.length, ratio: sent.length ? hidden.length / sent.length : 0, sameKey }
}

/** §9.5「同类信号再犯升一档」：同 reason 的上一档已知 ⇒ 升一级（封顶 L3） */
export const escalateStopLevel = (level, previous) => {
  if (!previous) return STOP_LEVEL_ORDER.includes(level) ? level : 'L1'
  const base = Math.max(STOP_LEVEL_ORDER.indexOf(level), STOP_LEVEL_ORDER.indexOf(previous.level))
  const next = Math.min(STOP_LEVEL_ORDER.length - 1, (base < 0 ? 1 : base) + 1)
  return STOP_LEVEL_ORDER[next]
}

/**
 * 止损判定（§9.5）：返回 { level, reason, evidence, escalated } 或 null。
 * 已有未清除停损 ⇒ 不重复触发（停损期内只报不叠加）。
 */
export const evaluateStop = (ledger, now = Date.now()) => {
  if (openStopRecord(ledger)) return null
  const events = eventsSinceClear(ledger)
  const triggered = []
  const push = (level, reason) => triggered.push({ level, reason })
  for (const e of events) {
    const code = String(e?.code ?? '')
    const detail = String(e?.detail ?? '')
    if (code === 'send-unknown') push('L1', 'send-unknown')
    if (RISK_CODE_RE.test(code) || (code === 'send-rejected' && RISK_RE.test(detail))) push('L1', 'risk-code')
    if (code === 'send-rejected:12014') push('L0', 'comment-quota')
    if (code === 'render-error') push('L0', 'render-error')
  }
  if (numOrZero(ledger?.fail_streak) >= 3) push('L1', 'consecutive-failures')
  const dom = domHiddenStats(sentRows(ledger))
  if (dom.total >= 2 || (dom.total >= 1 && dom.ratio >= 0.2)) push('L3', 'dom-hidden')
  else if (dom.sameKey >= 2) push('L3', 'dom-hidden-same-target')
  else if (dom.total >= 1) push('L2', 'dom-hidden-1')
  if (!triggered.length) return null
  // 同时命中多个档位取最高；同 reason 的上一轮停损已知 ⇒ 升一档
  const rank = (item) => STOP_LEVEL_ORDER.indexOf(item.level)
  triggered.sort((a, b) => rank(b) - rank(a))
  const top = triggered[0]
  const previous = ledger?.stop && ledger.stop.cleared_at && ledger.stop.reason === top.reason ? ledger.stop : null
  const level = escalateStopLevel(top.level, previous)
  return { level, reason: top.reason, escalated: Boolean(previous) && level !== top.level, evidence: triggered.map((item) => item.reason) }
}

/** 降速判定（§9.5 不停跑）：连续 2 次 unknown 或最近 2 条已发的 V1 全判 miss/invisible */
export const evaluateSpeed = (ledger) => {
  if (ledger?.speed?.downgraded) return null
  if (numOrZero(ledger?.unknown_streak) >= 2) return { reason: 'unknown-streak' }
  const rows = sentRows(ledger).sort((a, b) => numOrZero(b.posted_ts) - numOrZero(a.posted_ts)).slice(0, 2)
  if (rows.length < 2) return null
  // miss 与 invisible 同权：两者都只算「待复核」（§9.5 不单独判不可见），但连续两次都查不到时
  // 已经足够触发「降速 1 条/天」这一档保守动作（不停跑）。
  const statuses = rows.map((row) => String(row?.v1_24h?.status || row?.v1_30min?.status || ''))
  if (statuses.every((status) => status === 'miss' || status === 'invisible')) return { reason: 'v1-unverified' }
  return null
}

/** 报警不停跑（§9.5）：no-hook 连续 3 次 / 官腔 warn 连续 5 条 —— 只在尾部连续时各报一次 */
export const evaluateAlerts = (ledger) => {
  const events = eventList(ledger)
  const tailCount = (pred) => {
    let n = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (!pred(events[i])) break
      n += 1
    }
    return n
  }
  const last = events[events.length - 1]?.code ?? ''
  const out = []
  const noHook = tailCount((e) => e?.code === 'no-hook')
  if (noHook >= 3 && last !== 'alert:no-hook') out.push({ code: 'alert:no-hook', detail: '连续 ' + noHook + ' 次写不出钩子（§9.5 报警不停跑，修提示词/预算）' })
  const tone = tailCount((e) => e?.code === 'tone-warn')
  if (tone >= 5 && last !== 'alert:tone-warn') out.push({ code: 'alert:tone-warn', detail: '官腔 warn 连续 ' + tone + ' 条（§9.5 报警不停跑，修提示词/预算）' })
  return out
}

/** 恢复档是否该结束：恢复首日那条的 V1 24h 判 hit ⇒ 回正常档；其余状态维持 1 条/天 */
export const recoveryVerdict = (ledger) => {
  const rec = recoveryRecord(ledger)
  if (!rec) return null
  const row = sentOnDay(ledger, String(rec.day ?? '')).find((item) => item.sent === true)
  if (!row) return { status: 'waiting', day: rec.day }
  const status = String(row?.v1_24h?.status ?? '')
  if (!status) return { status: 'waiting', day: rec.day }
  return { status: status === 'hit' ? 'ok' : 'unverified', day: rec.day, v1: status }
}
