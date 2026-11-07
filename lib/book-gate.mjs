/**
 * lib/book-gate.mjs —— 书源门客户端壳（规格 docs/spec-whale-bili-book-comment.md §6.2）
 * ============================================================================
 * 职责只有一件：把书评请求交给本机 vendor/book-gate/client.py（ssh → 服务器固定脚本），
 * 把 JSON 响应原样带回给宿主。块格式、台账检索、claim 全在服务器脚本里；
 * 本文件不懂块格式，也**绝不重试**（claim 不可逆：超时/失败重发是孤儿分享的最短路径，§6.6）。
 *
 * 结构性保证（§6.2 硬约束的双保险）：
 *   · 响应里出现 quarkLink / passcode / baiduLink / baiduPasscode 任何一个字段 ⇒ gate-error
 *     （链接只允许存在于服务器脚本进程与本机发送链，模型永远看不见）。
 *   · 命中却缺 block / bookId ⇒ gate-error（没块就没法注入，宁可不发）。
 */

import { spawn as nodeSpawn } from 'node:child_process'

/** client.py 内部 SSH 总预算 330s（§6.1 预算的包络）；外壳再加一层兜底。 */
export const BOOK_GATE_DEFAULT_TIMEOUT_MS = 350000

/** 响应里禁带字段：出现即视为契约被破坏，整笔回 gate-error（§6.2）。 */
const FORBIDDEN_RESPONSE_KEYS = ['quarkLink', 'passcode', 'baiduLink', 'baiduPasscode']

/**
 * 请求 → 响应（结构化失败，不抛异常）。
 * @param {{title: string, subtitle?: string, author?: string, aliases?: string[]}} request
 * @param {{pythonPath?: string, clientScript?: string, timeoutMs?: number, spawnFn?: Function}} opts
 *   spawnFn 仅供测试注入；生产走 node:child_process 的 spawn。
 */
export async function callBookGate(request, opts = {}) {
  const spawnFn = typeof opts.spawnFn === 'function' ? opts.spawnFn : nodeSpawn
  const pythonPath = String(opts.pythonPath || 'python3')
  const clientScript = String(opts.clientScript || '')
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : BOOK_GATE_DEFAULT_TIMEOUT_MS
  if (!clientScript) return { ok: false, code: 'gate-error', detail: 'book-gate 客户端路径未配置（vendor/book-gate/client.py）' }
  if (!request || typeof request !== 'object' || Array.isArray(request) || !String(request.title ?? '').trim()) {
    return { ok: false, code: 'gate-error', detail: '书名不能为空' }
  }
  return await new Promise((resolve) => {
    let child
    try {
      child = spawnFn(pythonPath, [clientScript, JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      return resolve({ ok: false, code: 'gate-error', detail: '书源门进程启动失败' })
    }
    let stdout = ''
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve(result)
    }
    const timer = setTimeout(() => done({ ok: false, code: 'gate-timeout', detail: '书源门调用超时（不重试，§6.6）' }), timeoutMs)
    child.stdout?.on?.('data', (chunk) => { stdout += chunk })
    child.stderr?.on?.('data', () => { /* stderr 不进结果：banner 里可能有机器名等本机信息 */ })
    child.once?.('error', () => done({ ok: false, code: 'gate-error', detail: '书源门进程出错（详情不回显）' }))
    child.once?.('close', (code) => {
      let response
      try {
        response = JSON.parse((stdout || '').trim() || 'null')
      } catch {
        return done({ ok: false, code: 'gate-error', detail: '书源门返回无法解析（exit ' + (code ?? '?') + '）' })
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        return done({ ok: false, code: 'gate-error', detail: '书源门返回形状非法' })
      }
      if (FORBIDDEN_RESPONSE_KEYS.some((key) => Object.hasOwn(response, key))) {
        return done({ ok: false, code: 'gate-error', detail: '书源门响应带了禁带字段（链接必须只留在发送链内，§6.2）' })
      }
      if (response.ok === false) {
        const failCode = typeof response.code === 'string' && response.code ? response.code : 'gate-error'
        return done({ ok: false, code: failCode, detail: String(response.detail ?? '') })
      }
      if (response.ok !== true) {
        return done({ ok: false, code: 'gate-error', detail: '书源门响应缺 ok 字段' })
      }
      if (response.found && (!String(response.block ?? '').trim() || !String(response.bookId ?? '').trim())) {
        return done({ ok: false, code: 'gate-error', detail: '书源门命中但缺 block/bookId，无法注入' })
      }
      done(response)
    })
  })
}
