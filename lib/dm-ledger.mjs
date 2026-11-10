/**
 * lib/dm-ledger.mjs —— 鲸鱼私信线本地台账（规格 #1751 G 段）
 * ============================================================================
 * 私信线的**唯一业务权威**：一条记录 = 一次私信回复的尝试。
 * 与书评线的 `lib/whale-ledger.mjs` **同形不同文件**（落 `stateDir/whale-dm/ledger.json`），
 * 刻意不共用一份 JSON：两条线是不同账号行为、不同止损，混在一份里对账自愈会互相污染。
 *
 * 硬约束（规格 G 段，改之前先读）：
 *   · **私信正文绝不入账**。只记结构字段与长度：uid / msg_seqno / bookId / gateSource /
 *     blockLen / textLen / at / ok / riskCode / skipReason。
 *     理由同 lib/record-privacy.mjs：私信正文是隐私素材，落盘一次就是永久暴露面。
 *   · **不推服务端、不建表**（规格 G 段最后一条）：不写 `bili_comments`（那是评论表），
 *     建链后的台账回写由书源门自带（claim 成功自动回写，本文件不管链接）。
 *   · **发成功之后才记 ok:true**；失败保留原码，转人工核验（不重发，见 index.js 21047 分支）。
 *
 * 事件码（events[]，与规格 G 段逐字对齐）：
 *   dm-replied / dm-gate-miss / dm-ask-name / dm-dropped(21047) / dm-risk-blocked /
 *   dm-stale-skip / dm-over-limit
 */

import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { readJson, writeJson, dayKey } from './state.mjs'

export const DM_LEDGER_DIR = 'whale-dm'

/** rows / events 的封顶：私信量级比书评大（值守 3–5 分钟一跳），5000 ≈ 一两年的量 */
export const DM_LEDGER_MAX = 5000

export const dmLedgerFile = (stateDir) => join(stateDir, DM_LEDGER_DIR, 'ledger.json')

export const emptyDmLedger = () => ({ version: 1, rows: [], events: [], stop: null })

/** 原子落盘（写侧自带损坏拒写；目录首次创建）。调用方负责拿 withStateLock 串行化。 */
export const writeDmLedgerFile = (stateDir, ledger) => {
  mkdirSync(join(stateDir, DM_LEDGER_DIR), { recursive: true })
  writeJson(dmLedgerFile(stateDir), ledger)
}

const baseOf = (ledger, key) =>
  ledger && typeof ledger === 'object' && !Array.isArray(ledger) && Array.isArray(ledger[key]) ? ledger : emptyDmLedger()

/** 只取当天成功的回复条数（给工作台/日报看；跨天靠 day 字段判，不靠调用时机） */
export const dmSentTodayOf = (ledger, day) =>
  baseOf(ledger, 'rows').rows.filter((r) => r && r.ok === true && String(r.day ?? '') === String(day ?? '')).length

/**
 * 记一次私信回复（结构字段，**不含正文**）。
 * @param {object} ledger 原账本
 * @param {object} rec `{ uid, msg_seqno, bookId, gateSource, blockLen, textLen, ok, riskCode, skipReason, day, at }`
 */
export const withDmRow = (ledger, rec) => {
  const base = baseOf(ledger, 'rows')
  const row = {
    uid: String(rec.uid ?? ''),
    msg_seqno: String(rec.msg_seqno ?? ''),
    bookId: String(rec.bookId ?? ''),
    gateSource: String(rec.gateSource ?? ''),
    blockLen: Number(rec.blockLen) || 0,
    textLen: Number(rec.textLen) || 0,
    ok: rec.ok === true,
    riskCode: String(rec.riskCode ?? ''),
    skipReason: String(rec.skipReason ?? ''),
    day: String(rec.day ?? ''),
    at: String(rec.at ?? ''),
  }
  const rows = [...base.rows, row]
  // 超限按时间砍最早的（与 whale-ledger 同口径：老记录先走）
  if (rows.length > DM_LEDGER_MAX) rows.splice(0, rows.length - DM_LEDGER_MAX)
  return { ...base, rows }
}

/** 记一条事件（失败/跳过/风控）。`detail` 里同样不许出现私信正文。 */
export const withDmEvent = (ledger, rec) => {
  const base = baseOf(ledger, 'events')
  const events = [...base.events, {
    code: String(rec.code ?? ''),
    detail: String(rec.detail ?? ''),
    uid: String(rec.uid ?? ''),
    day: String(rec.day ?? ''),
    at: String(rec.at ?? ''),
  }]
  if (events.length > DM_LEDGER_MAX) events.splice(0, events.length - DM_LEDGER_MAX)
  return { ...base, events }
}

/**
 * 私信线停损（规格 #1751 §E：撞风控停 24h + 报本人；与书评线止损**分开记**）。
 * @param {object} rec `{ level, until, reason, code, day, at }`
 */
export const withDmStop = (ledger, rec) => ({
  ...baseOf(ledger, 'rows'),
  stop: {
    level: String(rec.level ?? ''),
    until: String(rec.until ?? ''),
    reason: String(rec.reason ?? ''),
    code: String(rec.code ?? ''),
    day: String(rec.day ?? ''),
    at: String(rec.at ?? ''),
  },
})

export const withDmStopCleared = (ledger, rec) => ({
  ...baseOf(ledger, 'rows'),
  stop: null,
  ...(rec && rec.note ? { lastStopNote: String(rec.note) } : {}),
})

/** 当前是否停损中（纯函数，假时钟可测） */
export const dmStopActive = (ledger, nowTs = Date.now()) => {
  const stop = ledger && typeof ledger === 'object' ? ledger.stop : null
  if (!stop || typeof stop !== 'object') return { active: false }
  const until = Date.parse(stop.until || '')
  if (!Number.isFinite(until)) return { active: false }
  return until > nowTs ? { active: true, stop } : { active: false, expired: true, stop }
}

/** 当天各 gate 来源的命中数（给工作台/日报：ledger 命中 vs 网盘 claim） */
export const dmSourceStats = (ledger, day) => {
  const rows = baseOf(ledger, 'rows').rows.filter((r) => r && r.ok === true && String(r.day ?? '') === String(day ?? ''))
  const out = {}
  for (const r of rows) {
    const key = r.gateSource || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

/** 当天被要过的书（bookId → 次数；按次数倒序，工作台直接渲染） */
export const dmBookStats = (ledger, day) => {
  const rows = baseOf(ledger, 'rows').rows.filter((r) => r && r.ok === true && String(r.day ?? '') === String(day ?? ''))
  const out = {}
  for (const r of rows) {
    if (!r.bookId) continue
    out[r.bookId] = (out[r.bookId] || 0) + 1
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]))
}

export { dayKey }
