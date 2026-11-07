/**
 * lib/whale-verify.mjs —— 鲸鱼书评线 V1 接口辅助核验（规格 docs/spec-whale-bili-book-comment.md §10.3；T5b）
 * ============================================================================
 * T+30min / T+24h 各一次：登录态 /x/v2/reply/main 找自己的评论（复用 lib/verify.mjs 的 verifyOne，
 * record 由 ledger 提供，不依赖 seen.md）。结果只写本地 ledger（hit / invisible / miss + likes/floor），
 * **不写服务端 visibility**——接口可见 ≠ 公开可见，判公开是 V2 DOM（T5c）的事。
 * floor/rcount 只在命中后用 reply/detail 补（§10.3：它对公开评论稳定误报 12006，绝不作可见性判据）。
 * 调度口径：不依赖进程内定时器存活——批起/批止 sweep 兜底（错过 T+30 只晚不缺）；
 * 发送后另挂 setTimeout 到点即查（进程活着就更接近 T+30）。
 * 纯 IO 注入（readLedger / writeRow / verifyOneImpl / replyDetailImpl / sleepImpl），可离线单测。
 */
import { dueV1Checks, withV1Result } from './whale-ledger.mjs'
import { verifyOne, replyDetail, headersFor } from './verify.mjs'

export const sweepV1 = async ({
  trigger = '',
  readLedger,
  writeRow,
  cred,
  headers,
  verifyOneImpl = verifyOne,
  replyDetailImpl = replyDetail,
  sleepImpl,
  log = () => {},
  max = 4,
  nowTs = Date.now(),
} = {}) => {
  if (typeof readLedger !== 'function' || typeof writeRow !== 'function') return { checked: 0, skipped: 'io-missing' }
  if (!cred) return { checked: 0, skipped: 'no-credential' }
  const hs = headers || headersFor(cred)
  const due = dueV1Checks(readLedger(), nowTs, { max })
  if (!due.length) return { checked: 0 }
  log('whale V1 sweep（' + trigger + '）：到期 ' + due.length + ' 条')
  const aidCache = new Map()
  const rest = (ms) => (typeof sleepImpl === 'function' ? sleepImpl(ms) : new Promise((r) => setTimeout(r, ms)))
  let checked = 0
  for (const { row, slot } of due) {
    const record = { rpid: String(row.rpid ?? ''), bv: String(row.bvid ?? ''), root: '0' }
    let result = null
    try {
      result = await verifyOneImpl(record, { cred, headers: hs, aidCache })
    } catch (e) {
      result = { visible: null, how: '', note: 'verifyOne 抛错：' + String(e?.message ?? e).slice(0, 100) }
    }
    const status = result?.visible === true ? 'hit' : result?.visible === false ? 'invisible' : 'miss'
    const entry = {
      at: new Date().toISOString(),
      status,
      likes: Number.isSafeInteger(result?.likes) ? result.likes : null,
      how: String(result?.how ?? '').slice(0, 80),
      note: String(result?.note ?? '').slice(0, 160),
    }
    if (status === 'hit' && typeof replyDetailImpl === 'function') {
      // verifyOne 自己把 aid 缓存进 aidCache（一次 view 查询两处用）；缓存没有再退回行内 aid
      const meta = aidCache.get(record.bv)
      const aid = String((meta && meta.aid) || row.aid || '').trim()
      if (/^\d+$/.test(aid)) {
        try {
          const d = await replyDetailImpl(aid, record.rpid, { headers: hs })
          const root = d && d.code === 0 && d.data && typeof d.data.root === 'object' ? d.data.root : null
          if (root) {
            entry.floor = Number.isSafeInteger(root.floor) ? root.floor : null
            entry.rcount = Number.isSafeInteger(root.rcount) ? root.rcount : null
          } else {
            // 12006 等：只记探测码，不反推可见性（§10.3 口径）
            entry.probe_code = d && d.code != null ? String(d.code).slice(0, 12) : 'no-data'
          }
        } catch { entry.probe_code = 'fetch-error' }
      }
    }
    await writeRow((l) => withV1Result(l, row.id, slot, entry))
    checked += 1
    log('whale V1(' + slot + ')：' + record.bv + ' rpid=' + record.rpid + ' → ' + status
      + (entry.floor != null ? ' floor=' + entry.floor : '')
      + (entry.likes != null ? ' 赞=' + entry.likes : ''))
    if (checked < due.length) await rest(700)
  }
  return { checked }
}
