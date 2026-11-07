import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emptyLedger, whaleLedgerFile, parseBlockContact,
  withGateHit, withBeforeSend, withAfterSend, withEvent,
  missingGuardSends, capLedger, WHALE_LEDGER_MAX,
} from '../lib/whale-ledger.mjs'

const NL = String.fromCharCode(10)
const QUARK_BLOCK = ['鲸鱼整理的《小岛经济学》资源包', 'https://pan.quark.cn/s/60fc0b3c0f8d', '提取码：22EM'].join(NL)
const BAIDU_BLOCK = ['鲸鱼整理的《杀死一只知更鸟》资源包', '链接：https://pan.baidu.com/s/1TKx', '提取码：ktiy', '（夸克 满速下载）'].join(NL)
const NOPASS_BLOCK = ['鲸鱼整理的《小岛经济学》资源包', 'https://pan.quark.cn/s/60fc0b3c0f8d'].join(NL)

test('parseBlockContact extracts url/code/disk from the block text', () => {
  assert.deepEqual(parseBlockContact(QUARK_BLOCK), { url: 'https://pan.quark.cn/s/60fc0b3c0f8d', code: '22EM', disk: 'quark' })
  assert.deepEqual(parseBlockContact(NOPASS_BLOCK), { url: 'https://pan.quark.cn/s/60fc0b3c0f8d', code: '', disk: 'quark' })
  assert.equal(parseBlockContact(BAIDU_BLOCK).disk, 'baidu')
  assert.equal(parseBlockContact(BAIDU_BLOCK).code, 'ktiy')
  assert.deepEqual(parseBlockContact(''), { url: '', code: '', disk: '' })
})

test('three write points accumulate one lifecycle record; same-id gate hit is idempotent', () => {
  let ledger = emptyLedger()
  const id = 'wl-test-1'
  ledger = withGateHit(ledger, {
    id, bvid: 'BV1234567890', bookId: 'island-economics', bookTitle: '小岛经济学',
    block: QUARK_BLOCK, fromLedger: true, jobId: null, candidateId: null, ledgerLookup: 'hit',
  })
  assert.equal(ledger.posted.length, 1)
  const wp1 = ledger.posted[0]
  assert.equal(wp1.book_id, 'island-economics')
  assert.equal(wp1.link, 'https://pan.quark.cn/s/60fc0b3c0f8d', 'WP1 的 link 从口令块解析')
  assert.equal(wp1.code, '22EM')
  assert.equal(wp1.disk, 'quark')
  assert.equal(wp1.from_ledger, true)
  assert.ok(wp1.gate_hit_at && wp1.gate_hit_ts > 0)

  ledger = withGateHit(ledger, { id, bvid: 'BV1234567890', bookId: 'island-economics', bookTitle: '小岛经济学', block: QUARK_BLOCK, fromLedger: true })
  assert.equal(ledger.posted.length, 1, '同 id 幂等（批准重放不重复建行）')

  ledger = withBeforeSend(ledger, id, { hook: '讲复利那三分钟本鱼来回听了三遍，嘿嘿。', block: QUARK_BLOCK, charCount: 65 })
  const wp2 = ledger.posted[0]
  assert.equal(wp2.hook, '讲复利那三分钟本鱼来回听了三遍，嘿嘿。')
  assert.equal(wp2.order_kind, 'quark')
  assert.equal(wp2.like_line, '', '无求赞行时为空串')
  assert.equal(wp2.char_count, 65)

  ledger = withBeforeSend(ledger, id, { hook: '看完求个赞呀。', block: QUARK_BLOCK, charCount: 40 })
  assert.equal(ledger.posted[0].like_line, '看完求个赞呀。', '求赞行被单独摘出')

  const at = new Date('2026-11-07T12:00:00+08:00').toISOString()
  ledger = withAfterSend(ledger, id, { rpid: '6789012345678901234', guardStatus: 'sent', sent: true, postedAt: at })
  const wp3 = ledger.posted[0]
  assert.equal(wp3.rpid, '6789012345678901234', 'rpid 一律十进制字符串')
  assert.equal(wp3.guard_status, 'sent')
  assert.equal(wp3.posted_at, at)
  assert.ok(wp3.posted_ts > 0)
})

test('events append with codes and carry bvid/book context', () => {
  let ledger = emptyLedger()
  ledger = withEvent(ledger, { code: 'gate-miss', bvid: 'BV1234567890', bookId: 'island-economics', detail: '没有可用资源' })
  ledger = withEvent(ledger, { code: 'hook-over-budget', bvid: 'BV1234567890', detail: '全文 168 字' })
  assert.equal(ledger.events.length, 2)
  assert.equal(ledger.events[0].code, 'gate-miss')
  assert.equal(ledger.events[1].code, 'hook-over-budget')
  assert.ok(ledger.events[0].at && ledger.events[0].ts > 0)
})

test('missingGuardSends diffs guard send rows against ledger by rpid then bvid+day', () => {
  const ledger = withAfterSend(
    withGateHit(emptyLedger(), { id: 'wl-a', bvid: 'BV1234567890', bookId: 'x', bookTitle: 'x', block: QUARK_BLOCK }),
    'wl-a',
    { rpid: '111', guardStatus: 'sent', sent: true, postedAt: new Date('2026-11-07T10:00:00+08:00').toISOString() },
  )
  const guardRows = [
    { key: 'send:comment:1', kind: 'send', status: 'sent', bvid: 'BV1234567890', rpid: '111', at: new Date('2026-11-07T10:00:05+08:00').toISOString() },
    { key: 'send:comment:2', kind: 'send', status: 'sent', bvid: 'BV1234567891', rpid: '222', at: new Date('2026-11-07T11:00:00+08:00').toISOString() },
    { key: 'send:comment:3', kind: 'send', status: 'sent', bvid: 'BV1234567892', rpid: '', at: new Date('2026-11-07T11:30:00+08:00').toISOString() },
    { key: 'send:comment:4', kind: 'send', status: 'unknown', bvid: 'BV1234567893', rpid: '333', at: new Date('2026-11-07T12:00:00+08:00').toISOString() },
  ]
  const missing = missingGuardSends(guardRows, ledger)
  assert.deepEqual(missing.map(r => r.rpid || r.bvid), ['222', 'BV1234567892'], '已记账的 111 不缺；unknown 状态不参与对账')
})

test('capLedger bounds posted and events, evicting the oldest first', () => {
  let ledger = emptyLedger()
  for (let i = 0; i < WHALE_LEDGER_MAX + 5; i++) {
    ledger = withEvent(ledger, { code: 'gate-miss', detail: String(i), tsOverride: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
  }
  assert.equal(ledger.events.length, WHALE_LEDGER_MAX, '事件封顶')
  assert.equal(ledger.events[0].detail, '5', '最老的被先砍')
})

test('whaleLedgerFile keeps the spec directory name under the runtime home', () => {
  assert.equal(whaleLedgerFile('/home/bili-duty').endsWith('/home/bili-duty/whale-book-comment/ledger.json'), true)
})
