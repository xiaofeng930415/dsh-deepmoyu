/**
 * lib/dm-watch.mjs —— 私信值守（规格 #1751 A/E/F 段；T8）
 * ============================================================================
 * 「有人来找就尽快回」的运行形态。与书评轮的调度**完全解耦**：
 *   · 书评轮 = 45 分钟一轮的 headless 子进程（runDuty → dsh --profile headless）；
 *   · 值守   = 本进程内每 N 分钟一跳的**轻量轮询**，只读收件箱，不刷视频不评论。
 * 为什么不能复用书评轮：把 45 分钟调到 3 分钟会连带挑片/读字幕/评论，
 *    token 与账号形态一起变密（规格 A 段原话）。
 *
 * 三条不变量（改之前先读）：
 *   ① **值守只发现、不发送**。本模块只回答「这一跳该不该看一眼收件箱」，
 *      真正的「读列表 → 起一轮回复」由宿主接线（回复链照旧过全部闸门）。
 *      理由：判定可离线单测；发送链的闸门（判重/节奏/21047/书源门）不该被复制第二份。
 *   ② **退避只影响读取**。撞 -509/-412 时把轮询间隔拉长（3→5→15），
 *      发送节奏（pace 的 dm 桶）一个数都不动 —— 那是另一个账本（规格 E 段）。
 *   ③ **时段外不发一眼**。07:00–24:00 是「醒着」的默认口径：夜间不回，
 *      既避免机器形态，也避免半夜把人叫起来（规格 A 段）。
 *
 * 停损（规格 E/F 段）：撞 21046 时宿主给这个模块记 `stopUntil`，
 *   停满前值守不起轮；恢复由 `dmWatchStopClear` 显式做（与书评线「恢复必须有人签」同原则）。
 */

/** 轮询间隔的默认值与范围（分钟）。规格 A 段：3–5 分钟一跳 */
export const DM_WATCH_POLL_MIN = 3
export const DM_WATCH_POLL_MAX = 5

/** 默认醒着时段（本地时间 HH:MM）。规格 A 段 */
export const DM_WATCH_DEFAULT_START = '07:00'
export const DM_WATCH_DEFAULT_END = '24:00'

/** 读取退避阶梯（毫秒）：撞一次风控码就退一档，恢复后回最低档 */
export const DM_WATCH_BACKOFF_MS = Object.freeze([3 * 60_000, 5 * 60_000, 15 * 60_000])

/** 一觉睡到明天的兜底：就算时段跨零点算错，也别真的 24 小时不睡 */
export const DM_WATCH_MAX_SLEEP_MS = 30 * 60_000

const minutesOf = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * 现在在不在醒着时段里（支持跨零点，如 22:00–06:00）。
 * 缺省/畸形 ⇒ **false**（不猜：畸形配置宁可不动，也不半夜回人）。
 */
export const dmWatchInWindow = (now, start = DM_WATCH_DEFAULT_START, end = DM_WATCH_DEFAULT_END) => {
  const s = minutesOf(start), e = minutesOf(end)
  if (s === null || e === null) return false
  if (s === e) return false                       // 起止相同 = 空窗口（不猜成全天）
  const cur = now.getHours() * 60 + now.getMinutes()
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)
}

/**
 * 这一跳该不该看一眼收件箱。纯函数（假时钟可测），零 IO。
 *
 * @param {object} cfg  运行态配置（只认 dmWatch / dmWatchPollMinutes / dmWatchStart / dmWatchEnd）
 * @param {object} st   state.json（只读 dmWatch 字段：{ lastPollAt, backoffStep, stopUntil, lastSeenAt }）
 * @param {number} nowTs 当前墙钟（毫秒）
 * @returns {{due: boolean, why: string, waitMs: number}}
 *   due=true 才去看；why 说清为什么（日志/界面直接用）
 */
export const dmWatchDue = (cfg = {}, st = {}, nowTs = Date.now()) => {
  const watch = st && typeof st === 'object' ? st.dmWatch : null
  const book = watch && typeof watch === 'object' ? watch : {}

  /* ① 开关三与（规格 F 段）：dmWatch && autoReplyDm && !sendReview。
   *   任一不满足都不启动 —— 人审速度就是 SLA，开着预览时值守等于「已读不回」。 */
  if (!cfg.dmWatch) return { due: false, why: 'dmWatch 未开启（工作台默认关，只有本人能开）', waitMs: 0 }
  if (!cfg.autoReplyDm) return { due: false, why: '「自动回复私信」未开启', waitMs: 0 }
  if (cfg.sendReview) return { due: false, why: '发送预览开着（人审速度就是 SLA）—— 值守不启动', waitMs: 0 }

  /* ② 停损中（规格 E 段：21046 停 24h）：停满前不起轮 */
  const stopUntil = Number(book.stopUntil) || 0
  if (stopUntil > nowTs) {
    return { due: false, why: `私信线停损中（到 ${new Date(stopUntil).toISOString()}）`, waitMs: Math.max(0, stopUntil - nowTs) }
  }

  /* ③ 醒着时段：时段外不发一眼 */
  if (!dmWatchInWindow(new Date(nowTs), cfg.dmWatchStart, cfg.dmWatchEnd)) {
    return { due: false, why: '醒着时段外（夜间不回，也不显得机器化）', waitMs: 0 }
  }

  /* ④ 间隔：退避阶梯（读取撞风控码后由宿主抬档）+ 正常档 */
  const step = Math.max(0, Math.min(DM_WATCH_BACKOFF_MS.length - 1, Number(book.backoffStep) || 0))
  const interval = DM_WATCH_BACKOFF_MS[step]
  const last = Number(book.lastPollAt) || 0
  if (nowTs - last < interval) {
    return { due: false, why: `未到下一跳（还要 ${Math.ceil((last + interval - nowTs) / 1000)} 秒）`, waitMs: last + interval - nowTs }
  }
  return { due: true, why: step > 0 ? `该看了（退避第 ${step} 档）` : '该看了', waitMs: 0 }
}

/** 记一次「刚看过」：顺带把退避档归零（看一眼成功 = 没被风控） */
export const dmWatchMarkPolled = (book = {}, nowTs = Date.now()) => ({
  ...(book && typeof book === 'object' ? book : {}),
  lastPollAt: nowTs,
  backoffStep: 0,
})

/** 撞风控码 ⇒ 退避升一档（封顶）；返回新账本 + 这一档等多久 */
export const dmWatchBackoff = (book = {}, nowTs = Date.now()) => {
  const base = book && typeof book === 'object' ? book : {}
  const step = Math.min(DM_WATCH_BACKOFF_MS.length - 1, (Number(base.backoffStep) || 0) + 1)
  return { book: { ...base, backoffStep: step, lastBackoffAt: nowTs }, waitMs: DM_WATCH_BACKOFF_MS[step] }
}

/** 停损（21046）：记 stopUntil，停满前值守不起轮 */
export const dmWatchStop = (book = {}, untilTs, code = '') => ({
  ...(book && typeof book === 'object' ? book : {}),
  stopUntil: Number(untilTs) || 0,
  stopCode: String(code || ''),
  stopAt: Date.now(),
})

/** 恢复：人工核验后显式清（与书评线「恢复必须有人签」同原则，模型不能自清） */
export const dmWatchStopClear = (book = {}) => {
  const base = book && typeof book === 'object' ? book : {}
  const next = { ...base, stopUntil: 0, stopCode: '' }
  delete next.stopAt
  return next
}

/** 给界面/日报看的一眼摘要（纯函数，不参与判定） */
export const dmWatchSummary = (cfg = {}, st = {}, nowTs = Date.now()) => {
  const book = st && typeof st === 'object' && st.dmWatch && typeof st.dmWatch === 'object' ? st.dmWatch : {}
  const due = dmWatchDue(cfg, st, nowTs)
  const stopUntil = Number(book.stopUntil) || 0
  const step = Math.max(0, Math.min(DM_WATCH_BACKOFF_MS.length - 1, Number(book.backoffStep) || 0))
  return {
    enabled: Boolean(cfg.dmWatch && cfg.autoReplyDm && !cfg.sendReview),
    configOnly: Boolean(cfg.dmWatch),
    window: { start: String(cfg.dmWatchStart || DM_WATCH_DEFAULT_START), end: String(cfg.dmWatchEnd || DM_WATCH_DEFAULT_END) },
    pollMinutes: DM_WATCH_BACKOFF_MS[step] / 60_000,
    backoffStep: step,
    inWindow: dmWatchInWindow(new Date(nowTs), cfg.dmWatchStart, cfg.dmWatchEnd),
    lastPollAt: Number(book.lastPollAt) ? new Date(Number(book.lastPollAt)).toISOString() : '',
    stop: stopUntil > nowTs ? { until: new Date(stopUntil).toISOString(), code: String(book.stopCode || '') } : null,
    due: due.due,
    why: due.why,
  }
}
