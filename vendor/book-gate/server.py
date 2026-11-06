#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""鲸鱼书源门 · 服务器侧固定脚本。

规格：docs/spec-whale-bili-book-comment.md §6（唯一口径）。
运行方式：经 ssh stdin 送入执行，不在服务器留第二份：

    ssh -T -i <key> root@<host> python3 - <请求.json

协议：stdin 读一个 JSON 请求，stdout 写一个 JSON 响应。

请求：
    {"title": "小岛经济学", "subtitle": "从储蓄起源到通胀真相",
     "author": "", "aliases": ["小岛经济学"], "book_id": "island-economics"}

响应（成功）：
    {"ok": true, "found": true, "source": "ledger|netdisk",
     "bookId": "...", "bookTitle": "...", "disk": "quark|baidu",
     "block": "（口令块，逐字）", "blockLen": 51, "fromLedger": true,
     "jobId": null, "candidateId": null}

响应（失败）：
    {"ok": false, "code": "gate-miss|gate-unauthorized|gate-timeout|gate-error|
     render-error|claim-failed|claim-timeout|claim-orphan-suspect", "detail": "..."}

硬约束：
  · 响应里不出现链接/提取码的**独立字段**；链接只存在于本进程与最终口令块里，
    调用方（宿主）只把 block 拼进评论，模型永远看不到链接文本。
  · claim 不可逆 ⇒ 只发一次、超时不重发、失败不换候选。
  · 不搜站外：台账先查；零命中才建 `mode='netdisk'` 作业，绝不发 `full`/`zlib-only`。
"""

import json
import os
import re
import socket
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

# ── 预算（照 delivery-extension/content/source-remote.js 同组标定值） ──────────
SEARCH_TIMEOUT_S = 90.0      # 检索段（台账变体 + netdisk 作业）
CLAIM_TIMEOUT_S = 90.0       # 建链段（claim + shares 收口）
TOTAL_TIMEOUT_S = 300.0      # 总收口
POLL_INTERVAL_S = 2.0

API_BASE = os.environ.get("BOOK_GATE_BASE", "http://127.0.0.1:8765")
ENV_FILE = os.environ.get("BOOK_GATE_ENV_FILE", "/etc/xianyu-links/book-gate.env")

# 归一化后（NFKC）的边界字符集：候选名与书名互相“开头”时，紧随字符落在集合内才算同书。
# 依据：docs/research/research-book-gate-candidate-convergence.md（双向边界前缀覆盖 92%）。
BOUNDARY = set("-—–:·/()[] ._")

QUARK_HOST = "pan.quark.cn"
BAIDU_HOST = "pan.baidu.com"
MATERIAL_MARK = "-全文资源包"
BAIDU_TAIL = "复制这段内容打开「百度网盘APP 即可获取」"
MAX_VARIANTS = 8

TERMINAL_STAGES = {"done", "finished", "error", "failed"}


class GateError(Exception):
    """带结构化 code 的失败；code 取值见模块 docstring。"""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


# ═══════════════════════════════════════════════════════════════════════════
# 一、归一化 / 变体 / 高置信判据（纯函数，可离线测）
# ═══════════════════════════════════════════════════════════════════════════

def normalize_name(value):
    """归一化：全角转半角（NFKC）→ 剥书名号/括号 → 去空白 → 小写。

    与 server/netdisk-match.js 的 normalizeName 同口径（规格 §6.4）。
    """
    text = unicodedata.normalize("NFKC", str(value or ""))
    for ch in "《》（）()[]【】":
        text = text.replace(ch, "")
    return "".join(text.split()).lower()


def _strip_book_marks(value):
    text = str(value or "").strip()
    for ch in "《》（）【】":
        text = text.replace(ch, "")
    return text.strip()


def build_variants(req):
    """检索用书名变体（去重保序）：原书名 / 剥书名号 / 主标题 / 副标题 / 作者+书名 / 别名。"""
    title = str(req.get("title") or "").strip()
    out = []

    def add(value):
        value = str(value or "").strip()
        if value and value not in out:
            out.append(value)

    add(title)
    stripped = _strip_book_marks(title)
    add(stripped)
    main = stripped
    for sep in ("：", ":"):
        if sep in stripped:
            main = stripped.split(sep, 1)[0].strip()
            break
    add(main)
    add(req.get("subtitle"))
    author = str(req.get("author") or "").strip()
    if author:
        add(author + stripped)
        add(stripped + author)
    for alias in req.get("aliases") or []:
        add(alias)
    return out[:MAX_VARIANTS]


def is_high_confidence(candidate_name, book_title):
    """T1：归一化全等，或双向“边界前缀”成立（规格 §6.4）。

    T2（主标题回退只记待办、不自动 claim）不在本函数内实现——调用方拿到 False 时不 claim 即可。
    """
    raw = re.sub(r"\s*[（(]\d+[)）]\s*$", "", str(candidate_name or ""))  # 副本编号 (1)/(2) 不算身份差异
    cand = normalize_name(raw)
    title = normalize_name(book_title)
    if not cand or not title:
        return False
    if cand == title:
        return True
    if cand.startswith(title):
        rest = cand[len(title):]
        return bool(rest) and rest[0] in BOUNDARY
    if title.startswith(cand):
        rest = title[len(cand):]
        return bool(rest) and rest[0] in BOUNDARY
    return False


def candidate_base_name(name):
    """候选基名：去掉 `-全文资源包` / 格式后缀 / `(n)` 尾巴，供 claim 前反查台账（规格 §6.6）。"""
    text = str(name or "").strip()
    if text.endswith(MATERIAL_MARK):
        text = text[: -len(MATERIAL_MARK)]
    for suffix in (".pdf", ".epub", ".azw3", ".mobi", ".txt", ".zip"):
        if text.lower().endswith(suffix):
            text = text[: -len(suffix)]
            break
    text = text.strip()
    # 末尾 (1) / （1） / (2) 之类的副本编号
    for left, right in (("(", ")"), ("（", "）")):
        if text.endswith(right):
            idx = text.rfind(left)
            if idx > 0 and text[idx + 1: -1].isdigit():
                text = text[:idx].rstrip()
    return text


def rank_candidates(candidates):
    """副本选优（规格 §6.5）：目录 → quark → 材料包 → 名字短 → depth 深 → 服务端顺序。"""
    indexed = list(enumerate(candidates or []))

    def key(item):
        idx, cand = item
        return (
            0 if cand.get("isDir") else 1,
            0 if (cand.get("disk") == "quark") else 1,
            0 if MATERIAL_MARK in str(cand.get("filename") or "") else 1,
            len(normalize_name(cand.get("filename"))),
            -int(cand.get("pathDepth") or 0),
            idx,
        )

    return [cand for _, cand in sorted(indexed, key=key)]


# ═══════════════════════════════════════════════════════════════════════════
# 二、口令块渲染（逐字固定；字数夹具见 fixtures/blocks.json）
# ═══════════════════════════════════════════════════════════════════════════

def render_quark(book_title, url, passcode):
    """夸克块：书名 / URL / 提取码：XXXX（全角冒号）；passcode 为空退化成两行。"""
    lines = [_strip_book_marks(book_title), str(url).strip()]
    code = str(passcode or "").strip()
    if code:
        lines.append("提取码：" + code)
    return "\n".join(lines)


def render_baidu(book_title, url, passcode):
    """百度四项块：分享文件名 / 链接:URL / 提取码:XXXX / 复制提示（半角冒号、无空格）。"""
    lines = [
        "通过百度网盘分享的文件：" + _strip_book_marks(book_title),
        "链接:" + str(url).strip(),
        "提取码:" + str(passcode or "").strip(),
        BAIDU_TAIL,
    ]
    return "\n".join(lines)


def render_block(disk, book_title, url, passcode):
    if disk == "quark":
        return render_quark(book_title, url, passcode)
    if disk == "baidu":
        return render_baidu(book_title, url, passcode)
    raise GateError("render-error", "未知盘位：" + str(disk))


# ═══════════════════════════════════════════════════════════════════════════
# 三、HTTP 面（可注入，测试用假的 http 替身）
# ═══════════════════════════════════════════════════════════════════════════

def load_token():
    """token 只从服务器本地取：环境变量优先，其次 root-only env 文件（规格 §6.1）。"""
    token = os.environ.get("BOOK_GATE_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(ENV_FILE, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key.strip() == "BOOK_GATE_TOKEN":
                    return value.strip().strip('"').strip("'")
    except OSError:
        pass
    raise GateError("gate-unauthorized", "服务器缺少 BOOK_GATE_TOKEN")


def default_http(method, path, body=None, timeout=30.0):
    """(method, path, body) → (status, payload)。401/403 抛 gate-unauthorized，网络/超时抛 gate-timeout。"""
    token = load_token()
    data = None
    headers = {"Authorization": "Bearer " + token}
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(API_BASE + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return response.status, json.loads(raw.decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read()
        if error.code in (401, 403):
            raise GateError("gate-unauthorized", "HTTP %s" % error.code)
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            payload = {}
        return error.code, payload
    except (urllib.error.URLError, socket.timeout, TimeoutError) as error:
        raise GateError("gate-timeout", str(error))


# ═══════════════════════════════════════════════════════════════════════════
# 四、台账检索
# ═══════════════════════════════════════════════════════════════════════════

def _valid_rows(items):
    rows = []
    for row in items or []:
        if not isinstance(row, dict):
            continue
        if row.get("expired") is True:
            continue
        rows.append(row)
    return rows


def search_ledger(http, variants):
    """逐个变体查 `/api/links/search`，返回跨变体去重后的有效行（规格 §6.3）。"""
    seen = {}
    had_generic_term = False
    for variant in variants:
        status, payload = http("GET", "/api/links/search?q=" + urllib.parse.quote(variant))
        if status in (401, 403):
            raise GateError("gate-unauthorized", "HTTP %s" % status)
        if status == 400:
            if (payload.get("error") or payload.get("code") or "") == "generic-term":
                had_generic_term = True
                continue
            raise GateError("gate-error", "HTTP 400：%s" % payload)
        if status != 200:
            raise GateError("gate-error", "HTTP %s" % status)
        data = payload.get("data") or {}
        for row in _valid_rows(data.get("items")):
            key = row.get("quarkFileId") or row.get("filename")
            if key and key not in seen:
                seen[key] = row
    if not seen and had_generic_term:
        return []
    return list(seen.values())


def pick_ledger_row(rows, book_title):
    """命中阈值（保守）：归一化全等优先；否则仅当唯一有效行才认；多行且无全等 ⇒ None（不确定）。"""
    title_norm = normalize_name(book_title)
    exact = [row for row in rows if normalize_name(row.get("filename")) == title_norm]
    if exact:
        return exact[0]
    if len(rows) == 1:
        return rows[0]
    return None


def ledger_link(row):
    """台账行 → (disk, url, passcode)；夸克优先，无夸克才用百度（规格 §6.3）。"""
    quark = str(row.get("quarkLink") or "").strip()
    if QUARK_HOST in quark:
        return "quark", quark, row.get("passcode")
    baidu = str(row.get("baiduLink") or "").strip()
    if BAIDU_HOST in baidu:
        return "baidu", baidu, row.get("baiduPasscode")
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 五、网盘作业 + claim
# ═══════════════════════════════════════════════════════════════════════════

def _poll_job(http, job_id, deadline, done):
    """轮询作业直到 done(job) 为真；超时抛 gate-timeout。"""
    while time.time() < deadline:
        status, payload = http("GET", "/api/discover/jobs/" + urllib.parse.quote(str(job_id)))
        if status in (401, 403):
            raise GateError("gate-unauthorized", "HTTP %s" % status)
        if status == 404:
            raise GateError("gate-error", "作业不存在：%s" % job_id)
        if status != 200:
            raise GateError("gate-error", "HTTP %s" % status)
        job = payload.get("data") or payload
        if done(job):
            return job
        time.sleep(POLL_INTERVAL_S)
    raise GateError("gate-timeout", "作业轮询超时：%s" % job_id)


def discover_netdisk(http, query, book_title, search_deadline):
    """建 `mode='netdisk'` 作业并取候选；无高置信候选返回空列表（规格 §6.3/§6.4）。"""
    status, payload = http("POST", "/api/discover/jobs", {"q": query, "mode": "netdisk"})
    if status in (401, 403):
        raise GateError("gate-unauthorized", "HTTP %s" % status)
    if status == 400:
        return [], None
    if status not in (200, 201):
        raise GateError("gate-error", "建作业失败 HTTP %s" % status)
    job_id = payload.get("jobId") or (payload.get("data") or {}).get("jobId")
    if not job_id:
        if (payload.get("status") or "") == "recent-miss":
            return [], None
        raise GateError("gate-error", "建作业响应缺少 jobId")

    def ready(job):
        stage = str(job.get("stage") or "")
        return bool(job.get("finishedAt")) or bool(job.get("errorCode")) or stage in TERMINAL_STAGES

    job = _poll_job(http, job_id, search_deadline, ready)
    if job.get("errorCode"):
        return [], job_id
    candidates = [
        cand for cand in (job.get("candidates") or [])
        if isinstance(cand, dict) and is_high_confidence(cand.get("filename"), book_title)
    ]
    return rank_candidates(candidates), job_id


def _share_of(job, candidate_id):
    for share in job.get("shares") or []:
        if not isinstance(share, dict):
            continue
        if str(share.get("candidateId") or "") == str(candidate_id):
            return share
    return None


def _share_link(share, disk):
    if disk == "baidu" or str(share.get("disk") or "") == "baidu":
        url = str(share.get("baiduLink") or "").strip()
        if BAIDU_HOST in url:
            return url, share.get("baiduPasscode")
    url = str(share.get("quarkLink") or "").strip()
    if QUARK_HOST in url:
        return url, share.get("passcode")
    url = str(share.get("baiduLink") or "").strip()
    if BAIDU_HOST in url:
        return url, share.get("baiduPasscode")
    return None


def claim_and_collect(http, job_id, candidate, claim_deadline):
    """claim 只发一次；超时/失败不重发，改轮询 `shares[]` 收口（规格 §6.6）。"""
    disk = "quark" if candidate.get("disk") == "quark" else "baidu"
    status, payload = http(
        "POST",
        "/api/discover/jobs/" + urllib.parse.quote(str(job_id)) + "/claim",
        {"candidateId": candidate.get("candidateId")},
    )
    if status in (400, 409):
        raise GateError("claim-failed", "claim 被拒 HTTP %s" % status)
    if status not in (200, 202):
        # 网络/未知结果：绝不重发，交给 shares 收口
        payload = payload or {}

    def has_share(job):
        return _share_of(job, candidate.get("candidateId")) is not None

    try:
        job = _poll_job(http, job_id, claim_deadline, has_share)
    except GateError:
        job = None
    if job is not None:
        link = _share_link(_share_of(job, candidate.get("candidateId")), disk)
        if link:
            return disk, link[0], link[1]
    # 收口失败：孤儿判据只看作业 error message（不自动重试）
    detail = "claim 后 shares[] 未出现候选"
    try:
        status, payload = http("GET", "/api/discover/jobs/" + urllib.parse.quote(str(job_id)))
        job = (payload.get("data") or payload) if status == 200 else {}
        message = str(job.get("message") or "")
        if "记账失败" in message:
            raise GateError("claim-orphan-suspect", message)
    except GateError:
        raise
    raise GateError("claim-timeout", detail)


# ═══════════════════════════════════════════════════════════════════════════
# 六、主流程
# ═══════════════════════════════════════════════════════════════════════════

def _ok(source, book_id, book_title, disk, block, from_ledger, job_id=None, candidate_id=None):
    return {
        "ok": True,
        "found": True,
        "source": source,
        "bookId": book_id,
        "bookTitle": book_title,
        "disk": disk,
        "block": block,
        "blockLen": len(block),
        "fromLedger": bool(from_ledger),
        "jobId": job_id,
        "candidateId": candidate_id,
    }


def _miss(detail, probed=0):
    return {"ok": False, "code": "gate-miss", "detail": detail, "probed": probed}


def handle(req, http=None):
    """协议入口：请求 dict → 响应 dict（不抛异常）。"""
    started = time.time()
    total_deadline = started + TOTAL_TIMEOUT_S
    search_deadline = started + SEARCH_TIMEOUT_S
    claim_budget = min(CLAIM_TIMEOUT_S, TOTAL_TIMEOUT_S - SEARCH_TIMEOUT_S)
    http = http or default_http

    title = str(req.get("title") or "").strip()
    if not title:
        return {"ok": False, "code": "gate-error", "detail": "title 不能为空"}
    book_title = _strip_book_marks(title)
    book_id = str(req.get("book_id") or normalize_name(book_title))
    variants = build_variants(req)

    try:
        rows = search_ledger(http, variants)
        row = pick_ledger_row(rows, book_title)
        if row:
            link = ledger_link(row)
            if link:
                disk, url, passcode = link
                block = render_block(disk, book_title, url, passcode)
                return _ok("ledger", book_id, book_title, disk, block, True)

        if time.time() >= search_deadline:
            raise GateError("gate-timeout", "检索段超时")
        query = _strip_book_marks(title)
        candidates, job_id = discover_netdisk(http, query, book_title, search_deadline)
        if not candidates:
            return _miss("台账与网盘均无高置信命中", probed=len(rows))

        chosen = candidates[0]
        base = candidate_base_name(chosen.get("filename"))
        if base and normalize_name(base) != normalize_name(book_title):
            reuse = pick_ledger_row(search_ledger(http, [base]), book_title)
            if reuse:
                link = ledger_link(reuse)
                if link:
                    disk, url, passcode = link
                    block = render_block(disk, book_title, url, passcode)
                    return _ok("netdisk", book_id, book_title, disk, block, True,
                               job_id=job_id, candidate_id=chosen.get("candidateId"))

        claim_deadline = min(time.time() + claim_budget, total_deadline)
        disk, url, passcode = claim_and_collect(http, job_id, chosen, claim_deadline)
        block = render_block(disk, book_title, url, passcode)
        return _ok("netdisk", book_id, book_title, disk, block, False,
                   job_id=job_id, candidate_id=chosen.get("candidateId"))
    except GateError as error:
        return {"ok": False, "code": error.code, "detail": error.detail}
    except Exception as error:  # noqa: BLE001 —— 固定脚本必须结构化失败，不能把 traceback 丢给调用方
        return {"ok": False, "code": "gate-error", "detail": "%s: %s" % (type(error).__name__, error)}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--self-test" in argv:
        import unittest
        here = os.path.dirname(os.path.abspath(__file__))
        suite = unittest.defaultTestLoader.discover(os.path.join(here, "tests"))
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        return 0 if result.wasSuccessful() else 1
    raw = sys.stdin.read()
    try:
        request = json.loads(raw or "{}")
    except ValueError as error:
        print(json.dumps({"ok": False, "code": "gate-error", "detail": "请求不是合法 JSON：%s" % error},
                         ensure_ascii=False))
        return 0
    print(json.dumps(handle(request), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
