import test from 'node:test'
import assert from 'node:assert/strict'
import { commentQuality, bookHookOf } from '../lib/comment.mjs'
import { keyNewComment, keyBook, keyUp, dupLookup, dupRemember, dupHitToday, DUP_LEDGER_MAX } from '../lib/dup.mjs'
import { callBookGate, BOOK_GATE_DEFAULT_TIMEOUT_MS } from '../lib/book-gate.mjs'

const NL = String.fromCharCode(10)
const HOOK = '讲复利那三分钟本鱼来回听了三遍，数字一减就懂了，嘿嘿。'

test('commentQuality bookReview downgrades official-talk to warn and keeps every other gate intact', () => {
  const official = '这条视频内容扎实、值得一看，逻辑清晰、结构完整，非常优秀。'
  assert.equal(commentQuality(official, { kind: 'comment' }).ok, false, '普通评论仍被官腔闸拦下')
  const warned = commentQuality(official, { kind: 'comment', bookReview: true })
  assert.equal(warned.ok, true)
  assert.ok(Array.isArray(warned.warnings) && warned.warnings.length === 1, JSON.stringify(warned))
  assert.ok(warned.warnings[0].startsWith('official-talk:'), warned.warnings[0])
  assert.ok(warned.warnings[0].includes('内容扎实') && warned.warnings[0].includes('值得一看'))
  // 其余闸全部不动（规格 §8.2：长度 150 / 口号 / 引用原话照旧；URL 从来不拦）
  assert.equal(commentQuality('', { kind: 'comment', bookReview: true }).ok, false, '空评论仍拦')
  assert.equal(commentQuality('awsl 666 hh', { kind: 'comment', bookReview: true }).ok, false, '纯口号仍拦')
  assert.equal(commentQuality('[01:47]「以前就是一勺半」这句比骂人狠', { kind: 'comment', bookReview: true }).ok, false, '引用原话闸仍拦')
  assert.equal(commentQuality('字'.repeat(151), { kind: 'comment', bookReview: true }).ok, false, '150 上限仍拦')
  assert.equal(commentQuality(HOOK, { kind: 'comment', bookReview: true }).ok, true)
  assert.equal(BOOK_GATE_DEFAULT_TIMEOUT_MS >= 300000, true, '外壳超时必须包住 client.py 的 330s 内部预算')
})

test('bookHookOf keeps only the hook: first line is the hook by composition invariant', () => {
  // 组合不变量：text = hook + 换行 + block，块永远从第二行起（行数随盘/提取码变化）
  const block3 = '鲸鱼整理的《小岛经济学》资源包\nhttps://pan.quark.cn/s/abc123\n提取码：ab12'
  const block1 = '鲸鱼整理的《小岛经济学》资源包：https://pan.quark.cn/s/abc123 提取码：ab12'
  assert.equal(bookHookOf(HOOK + NL + block3), HOOK)
  assert.equal(bookHookOf(HOOK + NL + block1), HOOK)
  assert.equal(bookHookOf(HOOK + NL + '中间不该有的一行' + NL + block3), HOOK, '历史文本同样只取首行（宁短勿长）')
  assert.equal(bookHookOf('没有链接的一句'), '没有链接的一句')
  assert.equal(bookHookOf('尾随空白应被剪掉' + NL), '尾随空白应被剪掉')
  assert.equal(bookHookOf(''), '')
  assert.equal(bookHookOf(null), '')
})

test('keyBook/keyUp share the same ledger face with daily-window semantics', () => {
  assert.equal(keyBook('island-economics'), 'book:island-economics')
  assert.equal(keyUp('3707002496747705'), 'up:3707002496747705')
  assert.equal(keyUp(123), 'up:123')
  assert.equal(keyBook(''), '')
  assert.equal(keyBook('a' + NL + 'b'), '')
  assert.equal(keyUp('0'), '')
  assert.equal(keyUp('abc'), '')
  let book = dupRemember({}, keyBook('island-economics'), { at: '2026-11-07T02:00:00.000Z', bvid: 'BV1234567890', bookId: 'island-economics' })
  book = dupRemember(book, keyNewComment('BV1234567890'), { at: '2026-11-07T02:00:00.000Z' })
  assert.equal(dupLookup(book, keyBook('island-economics')).hit, true)
  assert.equal(dupLookup(book, keyUp('3707002496747705')).hit, false, '没记过的 UP 不命中')
  // 「每日 ≤1」当日口径：同本地日命中；24h 前不算；没有 at 保守算当日
  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  assert.equal(dupHitToday(now.toISOString(), now), true)
  assert.equal(dupHitToday(new Date(now.getTime() - dayMs).toISOString(), now), false)
  assert.equal(dupHitToday('', now), true, '无 at 的老记录按保守算当日')
  // 同一面同淘汰：写满后最老的先被砍，最新的 book: 键仍在
  let big = book
  for (let i = 0; i < DUP_LEDGER_MAX + 5; i++) big = dupRemember(big, 'video:' + (9000000000 + i), { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
  assert.equal(Object.keys(big).length, DUP_LEDGER_MAX)
  assert.equal(dupLookup(big, 'video:9000000000').hit, false, '最老的条目被淘汰')
  assert.equal(dupLookup(big, keyBook('island-economics')).hit, true, '最新的 book 键在同一面上存活')
})

function gateChild() {
  const data = []
  const close = []
  const error = []
  return {
    stdout: { on: (ev, fn) => { if (ev === 'data') data.push(fn) } },
    stderr: { on: () => {} },
    once: (ev, fn) => { if (ev === 'error') error.push(fn); if (ev === 'close') close.push(fn) },
    kill: () => true,
    emitData(chunk) { for (const fn of data) fn(chunk) },
    emitClose(code) { for (const fn of close) fn(code) },
    emitError() { for (const fn of error) fn(new Error('boom')) },
  }
}

test('callBookGate parses found responses and structurally refuses link fields', async () => {
  const good = { ok: true, found: true, source: 'ledger', bookId: 'island-economics', bookTitle: '小岛经济学', disk: 'quark', block: '夸克三行块', blockLen: 51, fromLedger: true }
  const seen = []
  const out = await callBookGate({ title: '小岛经济学' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: (command, args) => {
    seen.push({ command, args })
    const child = gateChild()
    queueMicrotask(() => { child.emitData(Buffer.from(JSON.stringify(good))); child.emitClose(0) })
    return child
  } })
  assert.equal(out.ok, true)
  assert.equal(out.found, true)
  assert.equal(out.block, '夸克三行块')
  assert.equal(seen.length, 1, 'gate 只 spawn 一次，不重试（§6.6）')
  assert.equal(seen[0].args[0].endsWith('client.py'), true)
  assert.equal(JSON.parse(seen[0].args[1]).title, '小岛经济学')
  // 结构性排除：响应带链接字段 ⇒ gate-error（§6.2 硬约束的双保险）
  const leak = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => {
    const child = gateChild()
    queueMicrotask(() => { child.emitData(Buffer.from(JSON.stringify(Object.assign({}, good, { quarkLink: 'https://pan.quark.cn/s/xyz', passcode: 'ab12' })))); child.emitClose(0) })
    return child
  } })
  assert.equal(leak.ok, false)
  assert.equal(leak.code, 'gate-error')
  // miss 原样透传
  const miss = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => {
    const child = gateChild()
    queueMicrotask(() => { child.emitData(Buffer.from(JSON.stringify({ ok: false, code: 'gate-miss', detail: '台账与网盘都没有' }))); child.emitClose(0) })
    return child
  } })
  assert.equal(miss.ok, false)
  assert.equal(miss.code, 'gate-miss')
  // stdout 不是 JSON ⇒ gate-error
  const junk = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => {
    const child = gateChild()
    queueMicrotask(() => { child.emitData(Buffer.from('not json')); child.emitClose(1) })
    return child
  } })
  assert.equal(junk.ok, false)
  assert.equal(junk.code, 'gate-error')
  // 命中却缺 block/bookId ⇒ gate-error（没块就没法注入）
  const hollow = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => {
    const child = gateChild()
    queueMicrotask(() => { child.emitData(Buffer.from(JSON.stringify({ ok: true, found: true, source: 'ledger', bookId: '', block: '' }))); child.emitClose(0) })
    return child
  } })
  assert.equal(hollow.ok, false)
  assert.equal(hollow.code, 'gate-error')
  // spawn 抛错 ⇒ gate-error；空书名 ⇒ 不 spawn
  const boom = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => { throw new Error('no python') } })
  assert.equal(boom.ok, false)
  assert.equal(boom.code, 'gate-error')
  let spawned = 0
  const empty = await callBookGate({ title: ' ' }, { clientScript: 'vendor/book-gate/client.py', spawnFn: () => { spawned++; return gateChild() } })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'gate-error')
  assert.equal(spawned, 0)
})

test('callBookGate timeout maps to gate-timeout and kills the child', async () => {
  const killed = []
  const out = await callBookGate({ title: 'x' }, { clientScript: 'vendor/book-gate/client.py', timeoutMs: 30, spawnFn: () => {
    const child = gateChild()
    child.kill = () => { killed.push('SIGKILL'); return true }
    return child
  } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'gate-timeout')
  assert.equal(killed.length, 1, '超时后进程被回收')
})
