import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RESOURCE_KEYWORDS, MAX_CONTEXT_ROWS, looksResourceSeeking, extractTitleCandidates, dmResourceIntent,
} from '../lib/dm-intent.mjs'

test('the resource filter is a conservative gate: clear chatter never reaches the book gate', () => {
  for (const text of [
    '', '   ', '在吗', '晚安', '谢谢你昨天那本书', '你家猫真可爱',
    '我刚刷完你评论区', '哈哈哈哈哈', '👋', 'morning',
  ]) {
    assert.equal(looksResourceSeeking(text), false, JSON.stringify(text))
    assert.equal(dmResourceIntent(text).seeking, false, JSON.stringify(text))
  }
})

test('common resource phrasings are caught by the rule prefilter', () => {
  for (const text of [
    '有《小岛经济学》吗', '有没有经济学原理的资源', '求一本金字塔原理', '能发我一份吗',
    '我想要这个pdf', '求分享', '有电子版吗', '发我一下', '找一本书', '求个epub',
  ]) {
    assert.equal(looksResourceSeeking(text), true, JSON.stringify(text))
    assert.equal(dmResourceIntent(text).seeking, true, JSON.stringify(text))
  }
})

test('quoted titles are extracted and normalized without marks', () => {
  assert.deepEqual(extractTitleCandidates('有《小岛经济学》吗'), ['小岛经济学'])
  assert.deepEqual(extractTitleCandidates('求「资本论」'), ['资本论'])
  assert.deepEqual(extractTitleCandidates('想要《经济学原理（第8版）》'), ['经济学原理（第8版）'])
  // 引号 + 书名号同时出现 ⇒ 两个候选（规则不猜，交给模型确认）
  assert.deepEqual(extractTitleCandidates('有《小岛经济学》和「资本论」吗').sort(), ['小岛经济学', '资本论'].sort())
})

test('loose phrasing after a keyword still yields the book name', () => {
  assert.deepEqual(extractTitleCandidates('求一本小岛经济学'), ['小岛经济学'])
  assert.deepEqual(extractTitleCandidates('发我一下经济学原理'), ['经济学原理'])
  assert.deepEqual(extractTitleCandidates('想要资本论电子版'), ['资本论电子版'])
})

test('a bare reference resolves from context only when nothing was quoted', () => {
  // 无书名号 ⇒ 规则抽不出；上下文里最近一条被书名号包起来的是《小岛经济学》⇒ 补它
  const ctx = ['我最近在看《资本论》', '你推的那本真好', '有《小岛经济学》吗']
  assert.deepEqual(extractTitleCandidates('你推的那本能发我吗', ['我最近在看《资本论》']), ['资本论'])
  // 正文自己有书名号时**不**用上下文覆盖（正文是明确信号）
  assert.deepEqual(extractTitleCandidates('有《小岛经济学》吗', ['我最近在看《资本论》']), ['小岛经济学'])
  // 上下文也没有书名号 ⇒ 空
  assert.deepEqual(extractTitleCandidates('你推的那本能发我吗', ['昨天聊的那本', '很好看']), [])
})

test('multiple candidates or no candidate both mean ask, never guess', () => {
  const multi = dmResourceIntent('有《小岛经济学》和《资本论》吗')
  assert.equal(multi.seeking, true)
  assert.equal(multi.needAsk, true)
  assert.equal(multi.titles.length, 2)
  assert.match(multi.reason, /多个候选/)

  const none = dmResourceIntent('有资源吗')
  assert.equal(none.seeking, true)
  assert.deepEqual(none.titles, [])
  assert.equal(none.needAsk, true)
  assert.match(none.reason, /抽不出书名/)

  const single = dmResourceIntent('有《小岛经济学》吗')
  assert.equal(single.needAsk, false)
  assert.deepEqual(single.titles, ['小岛经济学'])
})

test('the result is stable, structured and free of IO (pure function contract)', () => {
  const rows = ['有《小岛经济学》吗', '在吗', '求一本资本论', '']
  const first = rows.map((r) => dmResourceIntent(r, ['前文']))
  const second = rows.map((r) => dmResourceIntent(r, ['前文']))
  assert.deepEqual(first, second)
  for (const row of first) {
    assert.deepEqual(Object.keys(row).sort(), ['needAsk', 'reason', 'seeking', 'titles'])
    assert.equal(typeof row.seeking, 'boolean')
    assert.equal(typeof row.needAsk, 'boolean')
    assert.ok(Array.isArray(row.titles))
  }
  // 入参畸形也不抛（宿主直接透传模型可见的文本）
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.equal(dmResourceIntent(bad).seeking, false)
  }
  // 关键词表是不可变冻结（防止运行时被谁改掉）
  assert.equal(Object.isFrozen(RESOURCE_KEYWORDS), true)
  assert.ok(Array.isArray(MAX_CONTEXT_ROWS) === false)
  assert.equal(MAX_CONTEXT_ROWS, 12)
})

test('candidate list is capped so a spammy message cannot fan out', () => {
  const many = Array.from({ length: 20 }, (_, i) => `《书名${i}》`).join('、')
  const titles = extractTitleCandidates('有' + many + '吗')
  assert.ok(titles.length <= 5)
  assert.equal(new Set(titles).size, titles.length)
})
