/**
 * lib/whale-push.mjs —— 鲸鱼书评线入库上报（规格 docs/spec-whale-bili-book-comment.md §10.2；T5b）
 * ============================================================================
 * 发时推 comments + videoSnapshots(source='entry')（§10.2 快照口径），通道 = fork vendor/bili-push/push.py
 * 逐字副本（源 = 主仓 tools/bili-promotion/push.py；SSH + 服务器本地 ADMIN_TOKEN，token 不出服务器）。
 * 本模块只做三件事，全部 IO 注入可离线单测：
 *   1. buildIngestPayload：ledger 行 → 服务端行（snake_case，server/db-bili.js 的 upsert 契约）。
 *      枚举与必填的唯一权威在服务端；这里只拦「本地已知会静默失败」的形状（必填缺失 / rpid 不安全）。
 *   2. runPush：spawn push.py（payload 走 stdin），exit 0 = push.py 已完成 upserted 回读验证；
 *      失败只留退出码——stderr 可能含服务器细节，永不回显（push.py 同一纪律）。
 *   3. ingestRows：批量编排（build → push → 结果），写账由调用方回 ledger（withIngest）。
 */
import { spawn } from 'node:child_process'

/** 服务端 note 归属字段（§10.5：运营端按它认出鲸鱼书评行） */
export const WHALE_INGEST_NOTE = 'account=whale;mode=book-review'

/**
 * rpid 十进制字符串 → 安全整数。本地一律字符串（§10.1），入库前过 Number.isSafeInteger 闸
 * （§10.2：server/db-bili.js 的 Number() 会静默改号，不安全的 rpid 拒推）。
 */
export const safeRpidInt = (rpid) => {
  const s = String(rpid ?? '').trim()
  if (!/^\d{1,15}$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

const positiveIntOrNull = (value) => {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 统计量（view/like…）允许 0：有限数原样进，其余 null（与 server biliNumberOrNull 同口径） */
const statNumOrNull = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * ledger 行 → ingest payload。返回 { payload } 或 { error }（row-incomplete / rpid-unsafe / rpid-missing）。
 * 服务端必填 = bvid/book_id/posted_at/posted_ts；rpid 是发送回执，书评线 sent 行必有——
 * 没有就不推（幂等键 (bvid,posted_ts) + rpid 唯一索引在服务端兜着，缺 rpid 的行没有入库身份）。
 * variant_raw = 完整评论文本（§10.2）：正常行 = hook + 换行 + block；对账补记行只有 text。
 */
export const buildIngestPayload = (row) => {
  const bvid = String(row?.bvid ?? '').trim()
  const bookId = String(row?.book_id ?? '').trim()
  const postedAt = String(row?.posted_at ?? '').trim()
  const postedTs = Number(row?.posted_ts)
  if (!bvid || !bookId || !postedAt || !Number.isSafeInteger(postedTs) || postedTs <= 0) return { error: 'row-incomplete' }
  const rpid = safeRpidInt(row?.rpid)
  if (!rpid) return { error: String(row?.rpid ?? '').trim() ? 'rpid-unsafe' : 'rpid-missing' }
  const stat = row?.entry_stat && typeof row.entry_stat === 'object' && !Array.isArray(row.entry_stat) ? row.entry_stat : {}
  const hook = String(row?.hook ?? '')
  const block = String(row?.block ?? '')
  const variantRaw = hook ? hook + (block ? '\n' + block : '') : String(row?.text ?? '')
  const kind = String(row?.order_kind ?? '')
  const capturedAt = new Date(postedTs)
  return {
    payload: {
      comments: [{
        bvid,
        aid: positiveIntOrNull(row?.aid),
        rpid,
        book_id: bookId,
        book_title: String(row?.book_title ?? '').trim() || bookId,
        mid: positiveIntOrNull(row?.mid),
        posted_at: postedAt,
        posted_ts: postedTs,
        hook_text: hook,
        order_kind: kind === 'quark' ? 'quark_first' : kind === 'baidu' ? 'baidu_first' : '',
        like_line: String(row?.like_line ?? ''),
        variant_raw: variantRaw,
        pool_score: null,
        pool_signals: null,
        deleted: 0,
        note: WHALE_INGEST_NOTE,
      }],
      videoSnapshots: [{
        bvid,
        source: 'entry',
        captured_ts: postedTs,
        captured_at: Number.isFinite(capturedAt.getTime()) ? capturedAt.toISOString() : new Date().toISOString(),
        view: statNumOrNull(stat.view),
        reply: statNumOrNull(stat.reply),
        like: statNumOrNull(stat.like),
        danmaku: statNumOrNull(stat.danmaku),
        pubdate_ts: statNumOrNull(stat.pubdate_ts),
      }],
      commentSnapshots: [],
      upSnapshots: [],
    },
  }
}

/**
 * 跑一次 push.py（payload 走 stdin）。push.py 内部自己验证「upserted = 发出行数」，不达标 exit 1；
 * 成功时从 stdout 的「已入库：」行解析计数（解析不出也只是计数缺失，不判失败）。
 */
export const runPush = ({ payload, pythonBin, scriptPath, spawnImpl = spawn, timeoutMs = 60000 }) =>
  new Promise((resolve) => {
    let child
    try {
      child = spawnImpl(pythonBin, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ ok: false, error: 'spawn-failed:' + String(e?.code ?? e?.message ?? '') })
    }
    let out = ''
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'push-timeout' }), Math.max(1000, Number(timeoutMs) || 60000))
    child.stdout?.on?.('data', (chunk) => { out = (out + String(chunk)).slice(-2000) })
    child.once?.('error', (e) => done({ ok: false, error: 'spawn-failed:' + String(e?.code ?? '') }))
    child.once?.('close', (code) => {
      if (code !== 0) return done({ ok: false, error: 'push-exit-' + String(code ?? '?') })
      const counts = {}
      const line = /已入库：([^\n]*)/.exec(out)
      if (line) for (const m of String(line[1]).matchAll(/(\w+)=(\d+)/g)) counts[m[1]] = Number(m[2])
      done({ ok: true, counts })
    })
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch { /* 进程已走，close/error 兜底 */ }
    child.stdin?.on?.('error', () => { /* EPIPE 走 close，不另起结果 */ })
  })

/**
 * 编排：逐行 build → push。返回 [{ id, row, ok, counts?, error? }]；build 失败也进结果
 * （调用方照常记账，rpid-unsafe 属持久错、调用方直接封口）。max 防一次推太多（每行一条 ssh）。
 */
export const ingestRows = async ({ rows, pythonBin, scriptPath, spawnImpl, timeoutMs, max = 5, log = () => {}, runPushImpl }) => {
  const push = runPushImpl || runPush
  const outcomes = []
  const list = Array.isArray(rows) ? rows.slice(0, Math.max(1, max)) : []
  for (const row of list) {
    const built = buildIngestPayload(row)
    if (built.error) {
      outcomes.push({ id: String(row?.id ?? ''), row, ok: false, error: built.error })
      log('whale ingest 跳过：' + built.error + ' bvid=' + String(row?.bvid ?? ''))
      continue
    }
    const result = await push({ payload: built.payload, pythonBin, scriptPath, spawnImpl, timeoutMs })
    outcomes.push({ id: String(row?.id ?? ''), row, ...result })
    log('whale ingest：bvid=' + String(row?.bvid ?? '') + ' rpid=' + String(row?.rpid ?? '') + ' → ' + (result.ok ? '已入库' : String(result.error ?? '失败')))
  }
  return outcomes
}
