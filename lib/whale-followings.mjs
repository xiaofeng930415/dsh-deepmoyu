/**
 * lib/whale-followings.mjs —— 鲸鱼号关注池（发现路径「只看讲书 UP 主」的数据层）
 * ============================================================================
 * 用户 2026-11-09 拍板：后台只看书籍相关视频；发现走「书单搜索 + 关注的讲书 UP 主近期更新」。
 * 关注列表可能有上千个、且每轮全量拉一次太贵 ⇒ 宿主维护本地关注池：
 *   · 全量分页拉取（MCP bili_followings all_pages）→ normalize 去重 → 落 DUTY/whale-followings.json；
 *   · TTL 6h 内复用缓存；每轮按游标轮转挑 8 个 UP 给模型（不会每轮都从第一页重复）；
 *   · 关注/取关后 invalidate（保留 ups 供「是否已关注」判断，但强制下次刷新）。
 * 纯函数，可离线单测；真实 IO 在 index.js。
 */

export const FOLLOW_POOL_TTL_MS = 6 * 3600_000
export const FOLLOW_BATCH_SIZE = 8
export const FOLLOW_POOL_MAX = 2000

export const emptyFollowPool = () => ({ version: 1, fetchedAt: '', fetchedTs: 0, total: 0, ups: [], cursor: 0 })

/** MCP 回包 list → 池（去重、截断、算关注天数）。 */
export const normalizeFollowPool = (list, { nowTs = Date.now(), total = 0 } = {}) => {
  const seen = new Set()
  const ups = []
  for (const item of Array.isArray(list) ? list : []) {
    const mid = String(item?.mid ?? '').trim()
    if (!mid || seen.has(mid)) continue
    seen.add(mid)
    const mtime = Math.max(0, Math.floor(Number(item?.mtime) || 0))
    ups.push({
      mid,
      uname: String(item?.uname ?? '').slice(0, 60),
      sign: String(item?.sign ?? '').slice(0, 120),
      followedTs: mtime > 0 ? mtime * 1000 : 0,
      followedDaysAgo: mtime > 0 ? Math.max(0, Math.floor((Number(nowTs) - mtime * 1000) / 86400_000)) : null,
    })
    if (ups.length >= FOLLOW_POOL_MAX) break
  }
  return { version: 1, fetchedAt: new Date(Number(nowTs) || Date.now()).toISOString(), fetchedTs: Number(nowTs) || Date.now(), total: Math.max(Number(total) || 0, ups.length), ups, cursor: 0 }
}

/** 刷新后合并：换新名单但保留游标（夹到新长度内），避免每次刷新都从第一个 UP 开始。 */
export const mergeFollowPool = (prev, fresh) => {
  const ups = Array.isArray(fresh?.ups) ? fresh.ups : []
  const cursor = Math.max(0, Math.min(Number(prev?.cursor) || 0, Math.max(0, ups.length - 1)))
  return { ...emptyFollowPool(), ...fresh, ups, cursor }
}

/** 池是否还在 TTL 内（空池/坏数据一律判过期）。 */
export const followPoolFresh = (pool, nowTs = Date.now(), ttl = FOLLOW_POOL_TTL_MS) => Boolean(
  pool && Array.isArray(pool.ups) && pool.ups.length > 0 &&
  Number(pool.fetchedTs) > 0 && Number(nowTs) - Number(pool.fetchedTs) < Number(ttl) && Number(pool.fetchedTs) <= Number(nowTs)
)

/** 轮转取一批（游标前进；到头回绕）。返回新池，调用方负责落盘。 */
export const selectFollowBatch = (pool, { size = FOLLOW_BATCH_SIZE } = {}) => {
  const ups = Array.isArray(pool?.ups) ? pool.ups : []
  const base = { ...emptyFollowPool(), ...(pool || {}), ups }
  if (!ups.length) return { batch: [], pool: base }
  const n = Math.max(1, Math.min(Math.floor(Number(size) || FOLLOW_BATCH_SIZE), ups.length))
  const start = Math.max(0, Math.min(Number(pool?.cursor) || 0, ups.length - 1))
  const batch = []
  for (let i = 0; i < n; i++) batch.push(ups[(start + i) % ups.length])
  return { batch, pool: { ...base, cursor: (start + n) % ups.length } }
}

export const followPoolHas = (pool, mid) => (Array.isArray(pool?.ups) ? pool.ups.some((u) => String(u?.mid ?? '') === String(mid)) : false)

/** 关注/取关后：保留名单（用于「已关注」去重），但让 TTL 失效 ⇒ 下次 batch 会重新全量刷新。 */
export const invalidateFollowPool = (pool, nowTs = Date.now()) => ({ ...emptyFollowPool(), ...(pool || {}), fetchedAt: '', fetchedTs: 0, invalidatedAt: new Date(Number(nowTs) || Date.now()).toISOString() })

/**
 * 给 bili_user_videos 回执做「有价值」标注（T3）：
 *   play_avg = 该 UP 本次返回列表的平均播放量；below_avg = 7 天内 且 play < 平均。
 * 样本不足（<2 条有 play 的）也能算，但 below_avg 只在均值有效时为 true。
 */
export const annotateUpVideos = (videos, { recentDays = 7 } = {}) => {
  const list = Array.isArray(videos) ? videos : []
  const plays = list
    .map((v) => v?.play)
    .filter((p) => p !== null && p !== undefined && Number.isFinite(Number(p)) && Number(p) >= 0)
    .map((p) => Number(p))
  const avg = plays.length ? plays.reduce((a, b) => a + b, 0) / plays.length : null
  return list.map((v) => {
    const play = v?.play === null || v?.play === undefined ? NaN : Number(v.play)
    const days = Number(v?.days_ago)
    const recent = Number.isFinite(days) && days <= Math.max(1, Number(recentDays) || 7)
    return { ...v, play_avg: avg == null ? null : Math.round(avg), below_avg: avg != null && Number.isFinite(play) && recent && play < avg }
  })
}


/** 关注动作的限流判据（T4）：每天 ≤ dailyCap、后台每轮 ≤ roundCap；已关注的不占额度。 */
export const planFollow = ({ stats = {}, roundId = '', day = '', dailyCap = 3, roundCap = 1 } = {}) => {
  const sameDay = String(stats?.day ?? '') === String(day)
  const count = sameDay ? Math.max(0, Math.floor(Number(stats?.count) || 0)) : 0
  const roundCount = sameDay && String(stats?.roundId ?? '') === String(roundId) ? Math.max(0, Math.floor(Number(stats?.roundCount) || 0)) : 0
  if (count >= dailyCap) return { ok: false, code: 'follow-daily-cap', count, roundCount }
  if (roundId !== 'session' && roundCount >= roundCap) return { ok: false, code: 'follow-round-cap', count, roundCount }
  return { ok: true, count, roundCount }
}

/** 记录一次关注动作结果（只统计真正新增的关注；already 不占额度）。 */
export const recordFollow = (stats = {}, { day = '', roundId = '', followed = false, mid = '', uname = '', nowTs = Date.now() } = {}) => {
  const sameDay = String(stats?.day ?? '') === String(day)
  const count = sameDay ? Math.max(0, Math.floor(Number(stats?.count) || 0)) : 0
  const roundCount = sameDay && String(stats?.roundId ?? '') === String(roundId) ? Math.max(0, Math.floor(Number(stats?.roundCount) || 0)) : 0
  return {
    day: String(day),
    count: count + (followed ? 1 : 0),
    roundId: String(roundId),
    roundCount: roundCount + (followed ? 1 : 0),
    last: { mid: String(mid), uname: String(uname || '').slice(0, 60), followed: followed === true, at: new Date(Number(nowTs) || Date.now()).toISOString() },
  }
}

