import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FOLLOW_POOL_TTL_MS, FOLLOW_BATCH_SIZE, emptyFollowPool, normalizeFollowPool, mergeFollowPool,
  followPoolFresh, selectFollowBatch, followPoolHas, invalidateFollowPool, annotateUpVideos,
  planFollow, recordFollow,
} from '../lib/whale-followings.mjs'

const NOW = new Date(2026, 10, 9, 12, 0, 0).getTime()
const items = (n) => Array.from({ length: n }, (_, i) => ({ mid: String(1000 + i), uname: 'UP' + i, sign: '讲书', mtime: Math.floor((NOW - (i + 1) * 86400_000) / 1000) }))

test('normalizeFollowPool：去重、截断、关注天数、空/坏输入', () => {
  const pool = normalizeFollowPool([...items(3), { mid: '1000', uname: '重复' }, { mid: '', uname: '无 id' }], { nowTs: NOW, total: 99 })
  assert.equal(pool.ups.length, 3)
  assert.equal(pool.ups[0].mid, '1000')
  assert.equal(pool.ups[0].followedDaysAgo, 1)
  assert.equal(pool.total, 99)
  assert.equal(pool.cursor, 0)
  assert.ok(pool.fetchedTs > 0)
  assert.deepEqual(normalizeFollowPool(null, { nowTs: NOW }).ups, [])
  assert.deepEqual(normalizeFollowPool([], { nowTs: NOW }).ups, [])
})

test('followPoolFresh：TTL 内新鲜、过期/空池/未来时间戳都不新鲜', () => {
  const pool = normalizeFollowPool(items(2), { nowTs: NOW })
  assert.equal(followPoolFresh(pool, NOW + 1000), true)
  assert.equal(followPoolFresh(pool, NOW + FOLLOW_POOL_TTL_MS + 1), false)
  assert.equal(followPoolFresh(emptyFollowPool(), NOW), false)
  assert.equal(followPoolFresh({ ...pool, fetchedTs: NOW + 60_000 }, NOW), false, '未来时间戳按坏数据')
})

test('selectFollowBatch：8 个一批、游标前进、到头回绕', () => {
  assert.equal(FOLLOW_BATCH_SIZE, 8)
  const pool = normalizeFollowPool(items(10), { nowTs: NOW })
  const first = selectFollowBatch(pool, { size: 8 })
  assert.deepEqual(first.batch.map((u) => u.mid), items(10).slice(0, 8).map((u) => u.mid))
  assert.equal(first.pool.cursor, 8)
  const second = selectFollowBatch(first.pool, { size: 8 })
  assert.deepEqual(second.batch.map((u) => u.mid), ['1008', '1009', '1000', '1001', '1002', '1003', '1004', '1005'])
  assert.equal(second.pool.cursor, 6)
  assert.deepEqual(selectFollowBatch(emptyFollowPool()).batch, [])
})

test('mergeFollowPool 保留游标；followPoolHas / invalidateFollowPool', () => {
  const pool = normalizeFollowPool(items(10), { nowTs: NOW })
  pool.cursor = 5
  const merged = mergeFollowPool(pool, normalizeFollowPool(items(3), { nowTs: NOW + 1 }))
  assert.equal(merged.cursor, 2, '夹到新长度内')
  assert.equal(merged.ups.length, 3)
  assert.equal(followPoolHas(pool, '1003'), true)
  assert.equal(followPoolHas(pool, 1003), true)
  assert.equal(followPoolHas(pool, 'nope'), false)
  const invalid = invalidateFollowPool(pool, NOW + 2)
  assert.equal(invalid.fetchedTs, 0)
  assert.ok(invalid.invalidatedAt)
  assert.equal(followPoolHas(invalid, '1003'), true, '失效后仍保留名单用于去重')
  assert.equal(followPoolFresh(invalid, NOW + 3), false)
})

test('annotateUpVideos：play_avg + 7 天内低于均值标注', () => {
  const videos = [
    { bvid: 'BV1', play: 100, days_ago: 2 },
    { bvid: 'BV2', play: 900, days_ago: 3 },
    { bvid: 'BV3', play: 40, days_ago: 30 },
    { bvid: 'BV4', play: null, days_ago: 1 },
  ]
  const out = annotateUpVideos(videos, { recentDays: 7 })
  assert.deepEqual(out.map((v) => v.play_avg), [347, 347, 347, 347])
  assert.deepEqual(out.map((v) => v.below_avg), [true, false, false, false])
  assert.equal(annotateUpVideos([]).length, 0)
  const low = annotateUpVideos([{ bvid: 'BVa', play: 10, days_ago: 1 }])
  assert.equal(low[0].play_avg, 10)
  assert.equal(low[0].below_avg, false, '只有一条时等于均值，不算低于')
})

test('planFollow / recordFollow：每天 3、每轮 1；already 不占额度；跨天重置', () => {
  const day = '2026-11-09', roundId = 'run-1'
  assert.deepEqual(planFollow({ stats: {}, roundId, day }), { ok: true, count: 0, roundCount: 0 })
  let stats = recordFollow({}, { day, roundId, followed: true, mid: '1', uname: 'UP1', nowTs: NOW })
  assert.equal(stats.count, 1); assert.equal(stats.roundCount, 1)
  assert.equal(planFollow({ stats, roundId, day }).code, 'follow-round-cap')
  assert.equal(planFollow({ stats, roundId: 'run-2', day }).ok, true, '新一轮可再关注 1 个')
  stats = recordFollow(stats, { day, roundId, followed: false, mid: '2' })
  assert.equal(stats.count, 1, 'already 不占额度')
  const capped = { day, count: 3, roundId: 'run-9', roundCount: 0 }
  assert.equal(planFollow({ stats: capped, roundId: 'run-9', day }).code, 'follow-daily-cap')
  assert.equal(planFollow({ stats: { day, count: 3, roundId, roundCount: 1 }, roundId: 'other', day }).code, 'follow-daily-cap', '跨轮也受每日上限')
  assert.equal(planFollow({ stats: { day: '2026-11-08', count: 3, roundId, roundCount: 1 }, roundId, day }).ok, true, '跨天重置')
})

