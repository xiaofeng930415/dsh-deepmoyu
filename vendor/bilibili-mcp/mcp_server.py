#!/usr/bin/env python3
"""
Bilibili MCP Server
B站数据采集 MCP 服务，支持 OpenClaw / Claude Code / Cursor / Cline

功能：搜索视频、抓取评论、获取字幕、弹幕、回复评论
首次运行需扫码登录B站，凭证自动保存复用
"""

# ⭐ 这个文件是从上游 AGI_Ananas/bilibili-mcp（MIT，见同目录 LICENSE）vendor 进来的。
#    本插件在它上面只加了下面这几处 —— **将来重新 vendor 时，这几处要原样补回来**（漏一处就少一道闸 ✗）：
#      ① `_ALLOWED` + `tool()` 白名单替身：工具按名单注册，名单外的连名字都不出现（见下）
#      ② `load_credential` 读取容错 + encoding="utf-8" + isinstance(data, dict) 校验
#      ③ 登录成功后凭证**原子写**（先写 .tmp 再 os.replace）
#      ④ `bili_comments` 把抓取异常带进返回（风控 -412 不再伪装成"这条视频 0 条评论"）
#      ⑤ `bili_reply` 回执带上 `rpid` / `rpid_str` / `root` / `parent`（判重表与评论复核要用）
#      ⑥ `bili_received_replies` 按真机结构拍平（root_rpid / reply_rpid / said / my_comment）
#      ⑦ `bili_dm_list` / `bili_dm_thread`：私信收件箱与往来（自动回私信要能先看见）
#      ⑧ `bili_my_notices`：点赞 / @ 通知拍平（原来 `bili_received_at_and_likes` 直接吐原始嵌套，
#         一层套一层根本读不动，模型只能"看到了但不知道谁赞了什么"）
#      ⑨ `bili_reply_opus`：动态（opus）下面的评论回复。**动态没有 BV 号**，走
#         `Dynamic(dynamic_id).get_info()` → `item.basic.comment_id_str` + `comment_type`
#         这两个字段才拿得到真正能评论的 oid 和 type（2026-10-20 真机验过：type=11 图文动态）。
#         `bili_received_replies` 里 business="动态" 的那类通知就靠它回。
import asyncio
import json
import base64
import os
import sys
import tempfile
from pathlib import Path
from functools import wraps
from pydantic import StrictInt, StrictStr
from mcp.server.fastmcp import FastMCP

# Strict union prevents Pydantic from accepting bool/float via implicit int coercion.
IdInput = StrictStr | StrictInt

from bilibili_api import video, search, comment, Credential, dynamic, opus
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta, Lines,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}


def tool():
    """@tool() 的替身：白名单里没有这个函数名，就原样返回、**不注册**。"""
    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        @wraps(fn)
        async def lossless_output(*args, **kwargs):
            value = await fn(*args, **kwargs)
            if isinstance(value, str):
                try:
                    value = json.loads(value)
                except (TypeError, ValueError):
                    return value
            # Every external ID, including nested raw SDK fallbacks, leaves Python as a string.
            return json.dumps(stringify_ids(value), ensure_ascii=False)
        return mcp.tool()(lossless_output)
    return deco


# ⭐⭐ 跨进程永久判重账本（2026-10-21 恢复）：runtime_guard.py 用 SQLite 记账，
#    「刷过的视频」「回过的评论 / 动态评论 / 私信」重启也不丢，而且**两个进程同时跑也只有一个能发出去**。
#    以前这些只写在 state.json / seen.md 里 —— 那是「提醒」，不是「保证」：
#    并发时两边都看到"没记过"就都发了，风控 -352 就是这么来的。
#
#    三个小工具的分工（下面每个工具都按这三步走）：
#      _get_runtime_guard()  → 本进程的账本句柄（懒加载，全进程一份）
#      _guarded_send(...)    → 占坑 → 真发 → 按回执落账（sent / rejected / unknown）
#      _guard_blocked(...)   → 占坑失败时该怎么回话（明确做过 / 上次结果不明 / 别人正在做）
try:
    # ⚠️ 这里**必须把用到的符号一起 import**（2026-10-21 事故：只 import 了 RuntimeGuard，
    #    于是 bili_reply / 私信 / 动态评论 全在 `key_*_reply` 上抛 NameError，
    #    表现是「评论、私信都发不出去」，而读评论不受影响）。
    from runtime_guard import (  # 同目录（家目录 bili-duty 里，由 ensureHomeFiles 铺过来）
        RuntimeGuard, key_video_reply, key_opus_reply, legacy_opus_keys, cross_channel_keys,
        key_dm_reply, legacy_dm_keys, key_moment, normalize_id, stringify_ids,
    )
except ImportError:  # 兜底：以模块方式跑时把本文件目录塞进 sys.path 再试一次
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent))
    from runtime_guard import (
        RuntimeGuard, key_video_reply, key_opus_reply, legacy_opus_keys, cross_channel_keys,
        key_dm_reply, legacy_dm_keys, key_moment, normalize_id, stringify_ids,
    )

# 单次字幕抓取的最长等待（秒）。超时 = 结果不明 ⇒ 但读是幂等的，超时要把坑退掉好重试。
READ_TIMEOUT_SECONDS = 180

_RUNTIME_GUARD = None


def _get_runtime_guard():
    """本进程的判重账本（懒加载）。家目录 = 本文件所在目录（凭证、state.json 都在这儿）。"""
    global _RUNTIME_GUARD
    if _RUNTIME_GUARD is None:
        _RUNTIME_GUARD = RuntimeGuard(Path(__file__).resolve().parent)
    return _RUNTIME_GUARD


def _guard_blocked(reservation, kind="send", why=""):
    """占坑失败时的话术。**必须说实话**：账本说「做过了」就是做过了，说「上次不明」就别自动重试。"""
    status = str(reservation.get("status") or "sent")
    at = str(reservation.get("at") or "")
    if status == "paced":
        details = {name: reservation[name] for name in ("reason", "pace_kind", "retry_at", "retryAt",
                   "wait_ms", "waitMs", "wait_seconds", "waitSec", "used", "cap") if name in reservation}
        out = {"success": False, "already_replied": False, "retry_blocked": False,
               "guard_status": "not_sent", "blocked": True, "pace": True, **details,
               "error": "共享节奏闸暂时拦住这次发送；到 retry_at 后再处理，不要连续试探",
               "hint": "GUI 与 headless 共用这一底线。等待期间先做读取、整理等不发送的工作。"}
        if reservation.get("reason") == "quota":
            out.update(limit_reached=True, limit_kind="comment")
        return json.dumps(out, ensure_ascii=False)
    if kind == "read":
        if status == "pending":
            message = "另一个进程正在读这条字幕 —— 这一轮先换别的视频"
        else:
            message = "这条已经刷过了（永久账本里有，重启也不会丢）—— 换一条"
        out = {
            "already_seen": True,
            "seen_recorded": False,
            "seen_at": at,
            "guard_status": status,
            "message": message,
            "hint": "already_seen=true ⇒ 直接换别的视频；确实要重读，就在 bili_say 里说清为什么",
        }
        if reservation.get("title"):
            out["title"] = reservation.get("title")
        return json.dumps(stringify_ids(out), ensure_ascii=False)
    if status == "unknown":
        return json.dumps({
            "success": False, "already_replied": True, "retry_blocked": True,
            "guard_status": "unknown", "seen_at": at,
            "error": "上一次发出去的结果不确定（超时 / 回执不明）—— 不许自动重发",
            "hint": "先自己去评论区 / 私信里看一眼到底发出去没有；确认没有，再手工重试",
        }, ensure_ascii=False)
    if status == "pending":
        return json.dumps({
            "success": False, "already_replied": True, "retry_blocked": False,
            "guard_status": "pending", "seen_at": at,
            "error": why or "另一个进程正在发同一条，这一轮别再发",
            "hint": "并发撞车时只有一边能发出去 —— 这一轮跳过它",
        }, ensure_ascii=False)
    return json.dumps({
        "success": False, "already_replied": True, "retry_blocked": False,
        "guard_status": status, "seen_at": at,
        "error": why or "这件事已经做过了（永久账本里有）",
        "hint": "已经回过了，别再回一遍 —— 重复发言最容易触发风控",
    }, ensure_ascii=False)


async def _guarded_send(guard, reservation, runner, record=None):
    """在**已经占好坑**的前提下真正发出去，并如实落账。

    返回 {"guard_status": "sent"|"rejected"|"unknown", "error", "retry_blocked", "result", "code"}
      sent     接口明确回了成功 ⇒ 记账为 sent
      rejected 接口明确拒绝（风控 / 未登录 / 无权限）⇒ 释放坑位，可以稍后重试
      unknown  超时 / 网络断 / 回执不明 / 被取消 ⇒ **坑位留着**，下次直接拦住，绝不自动重发

    ⚠️ 判据只看 `code` 在不在拒绝码表里，**不做 isinstance 判断**：
       不同版本的 bilibili_api 抛的异常类不一样，靠类名认会漏。
       重复发言比漏发糟得多 —— 漏发下一轮还能补，重复发言是当场掉信誉、还可能直接撞风控。
    """
    reject_codes = (-101, -102, -111, -352, -400, -403, -404, -412, -509, -799, 12006, 12014)
    # 12014 = 已达到当前评论发送上限（额度用完，服务器明确没发出去）；
    # 12006 = 没有该评论（对方自己删了）。这两个都是「确定没发出去」，必须释放坑位，
    # 否则会被当成 unknown 永久封死同一条回复的重试机会（10-21 就踩过这个坑）。
    quota_codes = (12014,)

    def _code_of(value):
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    def _rejected(error, result, code):
        pace = guard.reject_send(reservation, code)
        out = {"guard_status": "rejected", "error": error, "retry_blocked": False,
               "result": result, "code": code}
        if not pace.get("allowed", True):
            out.update({name: pace[name] for name in ("pace", "reason", "pace_kind", "retry_at", "retryAt",
                        "wait_ms", "waitMs", "wait_seconds", "waitSec") if name in pace})
        if code in quota_codes:
            out["limit_reached"] = True
            out["limit_kind"] = "comment"
        return out

    try:
        result = await runner()
    except asyncio.CancelledError:
        # 被取消 = 请求很可能已经到 B站 了 ⇒ 只能记 unknown
        guard.mark_unknown(reservation, record)
        raise
    except Exception as exc:
        code = _code_of(getattr(exc, "code", None))
        if code in reject_codes:
            return _rejected(str(exc), None, code)
        guard.mark_unknown(reservation, record)
        return {"guard_status": "unknown", "error": str(exc), "retry_blocked": True,
                "result": None, "code": code}

    if isinstance(result, dict) and result.get("success") is False:
        code = _code_of(result.get("code"))
        if code in reject_codes:
            return _rejected(str(result.get("error") or "接口明确拒绝"), result, code)
        guard.mark_unknown(reservation, record)
        return {"guard_status": "unknown", "error": str(result.get("error") or "没有确定的回执"),
                "retry_blocked": True, "result": result, "code": code}

    guard.commit_send(reservation, record)
    return {"guard_status": "sent", "error": "", "retry_blocked": False, "result": result, "code": None}


def ts_to_day(ts) -> str:
    """unix 秒 → 本地时区 YYYY-MM-DD；拿不到给空串。

    ⭐ 模块级（原来只在 bili_search 里当局部闭包，别的工具想用只能各写一遍）。
      新加的 bili_rank / bili_user_videos 都要把 created/pubdate 变成人能读的日期 ——
      光给一个 1792438295 模型根本判断不出"这是不是近七天的"，等于白给。
    """
    from datetime import datetime
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d") if ts else ""
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _days_ago(ts) -> int | None:
    """unix 秒 → 几天前（0 = 今天，1 = 昨天，…）。拿不到给 None。

    ⭐ 比日期字符串更直接：模型看「days_ago: 3」立刻知道在不在"近七天"里，
       不用自己做日期减法（那正是它容易算错的地方）。
    """
    from datetime import datetime
    try:
        if not ts:
            return None
        delta = datetime.now() - datetime.fromtimestamp(int(ts))
        return max(0, int(delta.total_seconds() // 86400))
    except (TypeError, ValueError, OSError, OverflowError):
        return None


def load_credential() -> Credential:
    """从文件加载凭证"""
    if not CRED_FILE.exists():
        return None
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        # ⚠️ 文件写坏一次（上一次写被打断）会让**所有**工具一起 JSONDecodeError：
        #    这里退化成「没登录」，重新扫一次码就能恢复。（2026-10-16 审查修）
        print(f"[bili-mcp] 凭证读不了（{type(e).__name__}: {e}）：{CRED_FILE}", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        return None
    return Credential(
        sessdata=data.get("sessdata", ""),
        bili_jct=data.get("bili_jct", ""),
        buvid3=data.get("buvid3") or "",
        dedeuserid=data.get("dedeuserid", ""),
    )


# ========== 登录会话（进程级缓存） ==========

_login_session: QrCodeLogin | None = None


def get_cred() -> Credential:
    """获取凭证，未登录时引导用户调用 bili_login"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    return cred


async def _self_mid(cred) -> int:
    """自己的 UID；取不到给 0（只用来标「这条是我自己发的」，不该因此让整个工具失败）"""
    try:
        info = await user.get_self_info(credential=cred) or {}
        return int(info.get("mid") or 0)
    except Exception:
        return 0


# ========== Tool: 扫码登录（生成二维码） ==========

@tool()
async def bili_login() -> str:
    """
    生成B站登录二维码，返回二维码图片（base64）供用户扫码。
    用户扫码后，调用 bili_login_check 检查登录状态。

    Returns:
        包含二维码base64图片数据的JSON，前端可直接渲染为图片展示给用户
    """
    global _login_session

    # 如果已有凭证，直接返回
    cred = load_credential()
    if cred:
        return json.dumps({
            "status": "already_logged_in",
            "message": "已登录B站，无需重复登录",
        }, ensure_ascii=False)

    # 生成新的登录会话
    _login_session = QrCodeLogin()
    await _login_session.generate_qrcode()

    # 获取二维码图片的 base64（无损PNG）
    pic = _login_session.get_qrcode_picture()
    img_base64 = base64.b64encode(pic.content).decode("utf-8")

    # 保存二维码图片到项目根目录
    qr_file = Path(__file__).parent / "qrcode_login.png"
    with open(qr_file, "wb") as f:
        f.write(pic.content)

    # 获取终端文本版二维码（纯文本客户端备用）
    terminal_qr = _login_session.get_qrcode_terminal()

    # 获取原始扫码URL（用户也可以手动在B站App打开）
    qr_url = getattr(_login_session, "_QrCodeLogin__qr_link", "")

    return json.dumps({
        "status": "qrcode_ready",
        "message": "请用B站App扫描二维码登录（180秒内有效）",
        "qrcode_image": f"data:image/png;base64,{img_base64}",
        "qrcode_file": str(qr_file),
        "qrcode_terminal": terminal_qr,
        "qrcode_url": qr_url,
        "next_step": "用户扫码后，请调用 bili_login_check 检查登录状态",
    }, ensure_ascii=False)


# ========== Tool: 检查登录状态 ==========

@tool()
async def bili_login_check() -> str:
    """
    检查B站扫码登录状态。在用户扫码后调用此工具。
    如果返回 "scanning" 或 "confirming"，请等待几秒后再次调用。
    如果返回 "done"，登录成功，可以使用其他工具了。
    如果返回 "timeout"，需要重新调用 bili_login 生成新二维码。

    Returns:
        当前登录状态
    """
    global _login_session

    if not _login_session:
        # 没有登录会话，检查是否已登录
        cred = load_credential()
        if cred:
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站",
            }, ensure_ascii=False)
        return json.dumps({
            "status": "no_session",
            "message": "没有进行中的登录，请先调用 bili_login 生成二维码",
        }, ensure_ascii=False)

    state = await _login_session.check_state()

    if state == QrCodeLoginEvents.SCAN:
        return json.dumps({
            "status": "scanning",
            "message": "已扫码，等待用户在手机上确认...",
            "next_step": "请等待3秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.CONF:
        return json.dumps({
            "status": "confirming",
            "message": "用户已确认，正在处理...",
            "next_step": "请等待2秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.TIMEOUT:
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "timeout",
            "message": "二维码已过期，请重新调用 bili_login 生成新二维码",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.DONE:
        # 登录成功，保存凭证
        cred = _login_session.get_credential()
        # ⚠️ 原子写：原来直接 open(w) 先截断再 dump，写到一半被打断就毁掉旧凭证，
        #    此后所有工具都读不了。（2026-10-16 审查修）
        tmp_cred = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
        with open(tmp_cred, "w", encoding="utf-8") as f:
            json.dump({
                "sessdata": cred.sessdata,
                "bili_jct": cred.bili_jct,
                "buvid3": cred.buvid3,
                "dedeuserid": cred.dedeuserid,
            }, f)
        os.replace(tmp_cred, CRED_FILE)
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "done",
            "message": "登录成功！凭证已保存，现在可以使用所有B站功能了",
        }, ensure_ascii=False)

    return json.dumps({
        "status": "unknown",
        "message": f"未知状态: {state}",
    }, ensure_ascii=False)


# ========== Tool: 登录状态查询 ==========

@tool()
async def bili_check_credential() -> str:
    """
    检查当前B站登录凭证是否有效

    Returns:
        登录状态信息
    """
    cred = load_credential()
    if not cred:
        return json.dumps({
            "logged_in": False,
            "message": "未登录，请调用 bili_login 进行扫码登录",
        }, ensure_ascii=False)

    # 尝试用凭证请求一下，验证是否过期
    try:
        my_info = await user.User(
            uid=int(cred.dedeuserid), credential=cred
        ).get_user_info()
        return json.dumps({
            "logged_in": True,
            "uid": cred.dedeuserid,
            "username": my_info.get("name", ""),
            "message": "凭证有效",
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "logged_in": False,
            "message": f"凭证可能已过期: {str(e)}，请重新调用 bili_login 登录",
        }, ensure_ascii=False)


# ========== Tool 1: 搜索视频 ==========

@tool()
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank", days: int = 0) -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
        days: 只看最近几天发布的（0=不限）
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主、发布时间等
    """
    from datetime import datetime

    def _pubdate_str(ts) -> str:
        """unix 秒 → 本地时区 YYYY-MM-DD；拿不到给空串。"""
        try:
            return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d") if ts else ""
        except (TypeError, ValueError, OSError, OverflowError):
            return ""

    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=order_enum,
    )

    videos = []
    for item in result.get("result", [])[:num]:
        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        try:
            pubdate = int(item.get("pubdate", 0) or 0)
        except (TypeError, ValueError):
            pubdate = 0
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            "description": item.get("description", "")[:200],
            # ⭐ 新增（老字段一个没删）：上游要按「近 N 天」筛，就必须拿到发布时间
            "pubdate": pubdate,
            "pubdate_str": _pubdate_str(pubdate),
            "author_mid": item.get("mid", item.get("author_mid", 0)) or 0,
            "is_union_video": item.get("is_union_video", 0),
        })

    filtered_out_all = False
    hint = ""
    if days > 0:
        cutoff = int(datetime.now().timestamp()) - days * 86400
        kept = [v for v in videos if v["pubdate"] and v["pubdate"] >= cutoff]
        if kept:
            videos = kept
        else:
            # 一条都不剩时别返回空列表了事：给兜底结果 + 明确标记，否则上游会把「没搜到」当「没新闻」
            filtered_out_all = True
            videos = videos[:min(num, 5)]
            hint = f"近 {days} 天没有匹配的，下面是综合排序的兜底结果"

    out = {"keyword": keyword, "count": len(videos), "days": days, "videos": videos}
    if filtered_out_all:
        out["filtered_out_all"] = True
        out["hint"] = hint
    return json.dumps(stringify_ids(out), ensure_ascii=False)


# ========== Tool 2: 获取评论 ==========

@tool()
async def bili_comments(bvid: str, num: int = 30) -> str:
    """
    获取B站视频的热门评论

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
    
    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=comment.OrderType.LIKE,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    "time": r.get("ctime", 0),
                }
                # 🎭 小表情元数据（[doge] 这类码 → 图片URL + 尺寸）：鱼看到合适的可以自己收进表情库
                emotes = content.get("emote") or {}
                if isinstance(emotes, dict) and emotes:
                    c["emotes"] = {
                        name: {"url": (meta.get("url") or ""), "size": meta.get("size", 1)}
                        for name, meta in emotes.items() if isinstance(meta, dict) and meta.get("url")
                    }
                # 🖼️ 图片评论（别人贴的图也是收集素材，只给地址不下载）
                pics = content.get("pictures") or []
                if isinstance(pics, list) and pics:
                    c["images"] = [
                        {"url": p.get("img_src", ""), "w": p.get("img_width"), "h": p.get("img_height")}
                        for p in pics if isinstance(p, dict) and p.get("img_src")
                    ]
                # 子评论
                sub_replies = []
                for sub in (r.get("replies") or [])[:2]:
                    sub_content = sub.get("content", {})
                    sub_item = {
                        "user": sub.get("member", {}).get("uname", ""),
                        "content": sub_content.get("message", ""),
                        "like": sub.get("like", 0),
                    }
                    sub_emotes = sub_content.get("emote") or {}
                    if isinstance(sub_emotes, dict) and sub_emotes:
                        sub_item["emotes"] = {
                            name: {"url": (meta.get("url") or ""), "size": meta.get("size", 1)}
                            for name, meta in sub_emotes.items() if isinstance(meta, dict) and meta.get("url")
                        }
                    sub_pics = sub_content.get("pictures") or []
                    if isinstance(sub_pics, list) and sub_pics:
                        sub_item["images"] = [
                            {"url": p.get("img_src", ""), "w": p.get("img_width"), "h": p.get("img_height")}
                            for p in sub_pics if isinstance(p, dict) and p.get("img_src")
                        ]
                    sub_replies.append(sub_item)
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。（2026-10-16 审查修）
            fetch_error = f"{type(e).__name__}: {e}"
            break

    out = {"bvid": bvid, "count": len(comments[:num]), "comments": comments[:num]}
    if fetch_error:
        out["error"] = fetch_error
    return json.dumps(stringify_ids(out), ensure_ascii=False)


# ========== Tool 3: 获取字幕 ==========

async def _fetch_subtitle(bvid: str, with_time: bool = False) -> str:
    """真正去 B站 抓字幕（只有网络这一段）。

    ⭐ 2026-10-21 拆出来的：判重那道闸必须在**打网络之前**占坑，
       所以「占坑 → 抓 → 落账」只能分三步写；抓取单独成函数，测试才能把网络整段换成假的。
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    info = await v.get_info()
    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = info["pages"][0].get("cid", 0)

    if not cid:
        return json.dumps({"error": "无法获取cid"}, ensure_ascii=False)

    subtitle_list = await v.get_subtitle(cid=cid)
    subtitles = subtitle_list.get("subtitles", [])

    if not subtitles:
        return json.dumps({"message": "该视频没有字幕"}, ensure_ascii=False)

    # 优先AI中文字幕
    target = None
    for s in subtitles:
        if s.get("lan") in ["ai-zh", "zh-CN", "zh"]:
            target = s
            break
    if not target:
        target = subtitles[0]

    # 下载字幕
    import aiohttp
    sub_url = target.get("subtitle_url", "")
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url
    # 有些 up 主上传的字幕给的是 http://，B站强制 https（走 http 会 403）
    if sub_url.startswith("http://"):
        sub_url = "https://" + sub_url[7:]

    async with aiohttp.ClientSession() as session:
        async with session.get(sub_url) as resp:
            sub_data = await resp.json()

    body = sub_data.get("body", []) or []

    def _fmt_ts(sec) -> str:
        """秒 → mm:ss.d（分钟两位、秒两位、保留 1 位小数）。"""
        try:
            total = float(sec)
        except (TypeError, ValueError):
            total = 0.0
        if total < 0:
            total = 0.0
        m = int(total // 60)
        s = total - m * 60
        return f"{m:02d}:{s:04.1f}"

    # ⚠️ 空白分段不算数：B站 有些字幕 body 整段都是 "   "（占位）。
    #    那种「看着有字幕」其实是空的 —— 记成「刷过」就等于白刷一条，
    #    而且会让它下轮永远不再重读（永久账本不裁剪）。
    segs = []
    for item in body:
        content = str(item.get("content") or "")
        if not content.strip():
            continue
        try:
            t = float(item.get("from", 0) or 0)
        except (TypeError, ValueError):
            t = 0.0
        try:
            to = float(item.get("to", 0) or 0)
        except (TypeError, ValueError):
            to = 0.0
        segs.append({"t": t, "to": to, "s": content})

    out = {
        "bvid": bvid,
        "title": info.get("title", ""),
        "language": target.get("lan_doc", ""),
        "segments": len(segs),
        "duration": segs[-1]["to"] if segs else 0.0,
        "text": "\n".join(x["s"] for x in segs),
    }
    if with_time:
        out["segments_detail"] = segs
        out["text"] = "\n".join(f"[{_fmt_ts(x['t'])}] {x['s']}" for x in segs)
    return json.dumps(stringify_ids(out), ensure_ascii=False)


@tool()
async def bili_subtitle(bvid: str, with_time: bool = False) -> str:
    """
    获取B站视频的AI字幕（语音转文字）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        with_time: 是否带上时间戳（True 时 text 每行前缀 [mm:ss.d]，并返回 segments_detail）

    Returns:
        视频的完整字幕文本（含 duration；with_time=True 时含时间戳与分段时间轴）。
        ⭐ 永久账本里已有这条 ⇒ 直接返回 already_seen=true，**不再花一次网络请求**。
    """
    guard = _get_runtime_guard()
    try:
        reservation = guard.reserve_read(bvid)
    except Exception as e:
        return json.dumps({"error": f"判重账本不可用，先不抓字幕：{e}"}, ensure_ascii=False)
    if not reservation.get("allowed"):
        return _guard_blocked(reservation, "read")

    try:
        raw = await asyncio.wait_for(_fetch_subtitle(bvid, with_time), timeout=READ_TIMEOUT_SECONDS)
    except BaseException:
        # 读是幂等的：超时 / 出错都该把坑退掉，下次还能重试
        guard.release(reservation)
        raise

    payload = raw
    if isinstance(raw, str):
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = None
    if not isinstance(payload, dict):
        guard.release(reservation)
        return raw if isinstance(raw, str) else json.dumps({"error": "字幕返回看不懂"}, ensure_ascii=False)

    try:
        count = int(payload.get("segments") or 0)
    except (TypeError, ValueError):
        count = 0
    if payload.get("error") or payload.get("message") or (count <= 0 and not str(payload.get("text") or "").strip()):
        # 没拿到内容 ⇒ 不算「刷过」，把坑退掉（下次还能重试）
        guard.release(reservation)
        return json.dumps(payload, ensure_ascii=False)

    guard.commit_read(reservation, {"bvid": bvid, "title": payload.get("title", "")})
    payload["seen_recorded"] = True
    return json.dumps(payload, ensure_ascii=False)


# ========== Tool 4: 获取弹幕 ==========

@tool()
async def bili_danmaku(bvid: str, num: int = 100) -> str:
    """
    获取B站视频的弹幕

    Args:
        bvid: 视频BV号
        num: 获取弹幕数量，默认100
    
    Returns:
        弹幕列表，包含弹幕文本和出现时间
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    danmakus = await v.get_danmakus(page_index=0)
    result = []
    for d in danmakus[:num]:
        result.append({
            "text": d.text,
            "time": d.dm_time,
        })

    return json.dumps({"bvid": bvid, "count": len(result), "danmakus": result}, ensure_ascii=False)


# ========== Tool 5: 视频详情 ==========

@tool()
async def bili_video_info(bvid: str) -> str:
    """
    获取B站视频的详细信息

    Args:
        bvid: 视频BV号
    
    Returns:
        视频标题、描述、UP主、播放量、评论数、收藏数等详细数据
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    stat = info.get("stat", {})

    from datetime import datetime

    try:
        pubdate = int(info.get("pubdate", 0) or 0)
    except (TypeError, ValueError):
        pubdate = 0
    pubdate_str = ""
    if pubdate:
        try:
            pubdate_str = datetime.fromtimestamp(pubdate).strftime("%Y-%m-%d")
        except (ValueError, OSError, OverflowError):
            pubdate_str = ""

    pages = info.get("pages", []) or []
    pages_detail = []
    if len(pages) > 1:
        pages_detail = [{
            "cid": p.get("cid", 0),
            "page": p.get("page", 0),
            "part": p.get("part", ""),
            "duration": p.get("duration", 0),
        } for p in pages]

    # 🐋 fork 本地补丁（2026-11-08，T6 真机自证发现）：上游只输出 author 名字、把 owner.mid 丢了，
    #    而舰鱼书评线要用 UP 的 mid 做 up:<uid> 每日判重与 ledger 的 mid 字段 ⇒ uid 预检永远 fail-closed。
    #    只增字段、不动既有字段（上游回贡候选）：owner.mid（字符串化由 stringify_ids 统一处理）+ owner_mid 平铺别名。
    owner = info.get("owner") if isinstance(info.get("owner"), dict) else {}
    return json.dumps({
        "bvid": info.get("bvid"),
        "aid": info.get("aid"),
        "title": info.get("title"),
        "description": info.get("desc"),
        "author": owner.get("name"),
        "owner": {"mid": owner.get("mid"), "name": owner.get("name")},
        "owner_mid": str(owner.get("mid")) if owner.get("mid") is not None else None,
        "duration": info.get("duration"),
        "pages": len(pages),
        "tags": [t.get("tag_name") for t in info.get("tag", []) if t.get("tag_name")],
        # ⭐ 新增：发布时间 + 不截断正文 + 分P明细（老字段一律保留）
        "pubdate": pubdate,
        "pubdate_str": pubdate_str,
        "desc_full": info.get("desc", ""),
        "pages_detail": pages_detail,
        "stat": {
            "view": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "favorite": stat.get("favorite", 0),
            "coin": stat.get("coin", 0),
            "like": stat.get("like", 0),
            "share": stat.get("share", 0),
        },
    }, ensure_ascii=False)


# ========== Tool 6: 回复评论 ==========

def build_pictures(images) -> list:
    """把图片参数（本地路径 / http(s) URL）解析成 Picture 列表（同步部分）。

    ⭐ 本地图用 Picture.from_file（同步）；URL 图是网络活 ⇒ 返回原字符串，
       由调用方在 async 上下文里 `await Picture.load_url(p)`（这版 bilibili_api 的真接口；
       `Picture.async_from_url` 在本版本**不存在**，bili_send_dynamic 原来就栽在这上面）。
    限制：最多 2 张（表情包评论一张就够）；每项必须非空字符串。
    """
    items = []
    if isinstance(images, str):  # 单张也收：pictures="路径" 等价于 pictures=["路径"]
        images = [images]
    items = [str(p).strip() for p in (images or []) if str(p or "").strip()]
    if not items:
        raise ValueError("pictures 里没有可用项")
    if len(items) > 2:
        raise ValueError("pictures 最多 2 张（表情包一张就够）")
    pics = []
    for p in items:
        if p.startswith(("http://", "https://")):
            pics.append(p)  # URL：留给调用方异步加载
        else:
            if not os.path.isfile(p):
                raise ValueError(f"图片不存在：{p}")
            pics.append(Picture.from_file(p))
    return pics


async def load_remote_pictures(pics) -> list:
    """把 build_pictures 结果里的 URL 项换成真的 Picture（网络加载失败就整体报错，不发残缺评论）。"""
    out = []
    for p in pics:
        if isinstance(p, str):  # URL 字符串
            out.append(await Picture.load_url(p))
        else:
            out.append(p)
    return out


@tool()
async def bili_reply(bvid: str, text: str, rpid: IdInput = "0", root: IdInput = "0", pictures: list[str] | None = None) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
        pictures: 表情图片路径列表（可选，最多2张；**只对发新评论 rpid=0 生效**，B站限制：回复楼层只能纯文字）

    Returns:
        发表结果（带 rpid 便于判重记账；带 guard_status 说明到底发没发出去）
    """
    # Validate before credentials, network, or a durable reservation. Invalid IDs never become new comments.
    try:
        rpid = normalize_id(rpid)
        root = normalize_id(root)
        if rpid == "0" and root != "0":
            raise ValueError("root requires a nonzero rpid")
        key = key_video_reply(bvid, rpid)
    except (TypeError, ValueError) as e:
        return json.dumps({"success": False, "error": str(e), "invalid_id": True,
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    # 楼层限制最先说清楚：回复楼层（rpid≠0）不收图。这条检查放在 build_pictures 之前，
    # 否则带图回复报的是「图片不存在」—— 说的根本不是真正的问题。
    if rpid != "0" and pictures:
        return json.dumps({"success": False, "error": "回复楼层（rpid≠0）接口不支持图片 —— B站限制，去掉 pictures 或改为发新评论",
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    # 图片参数同样在占坑前验证：不合法的图片不该烧掉这条 BV 的评论坑位。
    try:
        pic_list = build_pictures(pictures) if pictures else []
    except (TypeError, ValueError) as e:
        return json.dumps({"success": False, "error": str(e), "invalid_pictures": True,
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    # ① 预检：登录态 + aid。**这一步失败时还没占坑** ⇒ 下次还能重试（guard_status=not_sent）
    try:
        cred = get_cred()
        v = video.Video(bvid=bvid, credential=cred)
        info = await v.get_info()
        aid = info["aid"]
    except Exception as e:
        return json.dumps({"success": False, "error": str(e),
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)

    # ② 占坑：同一条评论（rpid）全机器只允许发一次；新评论按 BV 也只允许留一条
    guard = _get_runtime_guard()
    try:
        key = key_video_reply(bvid, rpid)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e),
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    reservation = guard.reserve_send(key, cross_channel_keys(rpid))
    if not reservation.get("allowed"):
        return _guard_blocked(reservation, "send",
                              "这条评论已经回过了" if rpid != "0" else "这条视频已经留过一条评论了")

    # ③ 真发
    async def _send():
        if rpid == "0":
            # 发表新评论
            return await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
                **({"pic": await load_remote_pictures(pic_list)} if pic_list else {}),
            )
        # 回复评论：root=0 表示回复一级评论；root!=0 表示回复楼中楼（root=根评论，parent=目标评论）
        actual_root = int(root if root != "0" else rpid)
        return await comment.send_comment(
            text=text,
            oid=aid,
            type_=comment.CommentResourceType.VIDEO,
            root=actual_root,
            parent=int(rpid),
            credential=cred,
        )

    outcome = await _guarded_send(guard, reservation, _send, {"bvid": bvid, "rpid": rpid})
    if outcome["guard_status"] != "sent":
        if outcome.get("limit_reached"):
            hint = "B站 的评论发送额度到顶了（12014，按账号算的，不是被风控）—— 今天别再试评论了，去回私信 / 回动态 / 翻字幕"
        elif outcome["guard_status"] == "unknown":
            hint = "这次不确定有没有发出去 —— 别自动重发，先去评论区看一眼"
        else:
            hint = "接口明确拒绝了（风控 / 未登录 / 权限），可以稍后再试"
        payload = {
            "success": False,
            "error": outcome["error"],
            "code": outcome.get("code"),
            "guard_status": outcome["guard_status"],
            "retry_blocked": outcome["retry_blocked"],
            "already_replied": outcome["guard_status"] == "unknown",
            "hint": hint,
        }
        payload.update({name: outcome[name] for name in ("pace", "reason", "pace_kind", "retry_at", "retryAt",
                        "wait_ms", "waitMs", "wait_seconds", "waitSec") if name in outcome})
        if outcome.get("limit_reached"):
            payload["limit_reached"] = True
            payload["limit_kind"] = "comment"
        return json.dumps(payload, ensure_ascii=False)

    # ④ 把回执里的 rpid 带回去：判重表要靠它记「我们发过哪条」，宿主的评论复核
    #    （lib/verify.mjs）也要拿它去 B站 查公开可见性。只回 success 的话那条链是断的。
    result = outcome["result"]
    out = {"success": True, "message": "评论发送成功", "guard_status": "sent"}
    if isinstance(result, dict):
        for name in ("rpid", "rpid_str", "root", "parent"):
            val = result.get(name)
            if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                out[name] = str(val)
    return json.dumps(stringify_ids(out), ensure_ascii=False)


# ========== Tool 7: 批量采集 ==========

@tool()
async def bili_crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 20, get_subtitles: bool = True) -> str:
    """
    批量采集：搜索B站视频并抓取每个视频的评论和字幕

    Args:
        keyword: 搜索关键词
        max_videos: 最多采集视频数，默认5
        comments_per_video: 每个视频采集评论数，默认20
        get_subtitles: 是否获取字幕，默认True
    
    Returns:
        包含视频信息、评论和字幕的完整采集数据
    """
    cred = get_cred()

    # 搜索
    search_result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=search.OrderVideo.TOTALRANK,
    )

    results = []
    for item in search_result.get("result", [])[:max_videos]:
        bvid = item.get("bvid", "")
        if not bvid:
            continue

        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        video_data = {
            "bvid": bvid,
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
        }

        # 评论
        comments_json = await bili_comments(bvid=bvid, num=comments_per_video)
        comments_data = json.loads(comments_json)

        # 字幕
        subtitle_text = ""
        if get_subtitles:
            try:
                subtitle_json = await bili_subtitle(bvid=bvid)
                subtitle_data = json.loads(subtitle_json)
                subtitle_text = subtitle_data.get("text", "")
            except:
                pass

        results.append({
            "video": video_data,
            "comments": comments_data.get("comments", []),
            "subtitle_text": subtitle_text,
        })

        await asyncio.sleep(1)

    return json.dumps({
        "keyword": keyword,
        "video_count": len(results),
        "total_comments": sum(len(r["comments"]) for r in results),
        "results": results,
    }, ensure_ascii=False)


# ========== 辅助：封面处理 ==========

import subprocess


def _extract_cover_from_video(video_path: str) -> Picture:
    """从视频第3秒截取一帧作为封面，返回 Picture 对象"""
    tmp_cover = os.path.join(tempfile.gettempdir(), f"bili_cover_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "3", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover) and os.path.getsize(tmp_cover) > 0:
            return Picture.from_file(tmp_cover)
    finally:
        if os.path.isfile(tmp_cover):
            os.remove(tmp_cover)
    # fallback: 第0秒
    tmp_cover2 = os.path.join(tempfile.gettempdir(), f"bili_cover2_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "0", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover2],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover2) and os.path.getsize(tmp_cover2) > 0:
            return Picture.from_file(tmp_cover2)
    finally:
        if os.path.isfile(tmp_cover2):
            os.remove(tmp_cover2)
    raise RuntimeError(f"无法从视频截取封面: {video_path}")




@tool()
async def bili_send_dynamic(
    text: str,
    images: list[str] | None = None,
    topic_id: int = 0,
    schedule_time: int = 0,
) -> str:
    """
    发布B站图文动态

    Args:
        text: 动态文本内容，支持@和表情（如 [doge]）
        images: 图片列表，每项可以是本地文件路径或图片URL，最多9张。为空则发布纯文字动态
        topic_id: 话题ID（可选，0表示不关联话题）
        schedule_time: 定时发布的Unix时间戳（可选，0表示立即发布）

    Returns:
        发布结果，包含动态ID
    """
    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    text = text.strip()
    image_paths = [str(path).strip() for path in (images or [])[:9] if str(path or "").strip()]
    guard = _get_runtime_guard()
    reservation = guard.reserve_send(key_moment("dynamic", {
        "text": text, "images": image_paths, "topic_id": str(topic_id), "schedule_time": schedule_time,
    }))
    if not reservation["allowed"]:
        return _guard_blocked(reservation)
    try:
        cred = get_cred()
        dyn = dynamic.BuildDynamic.empty()
        dyn.add_plain_text(text)
        for img_path in image_paths:
            if img_path.startswith(("http://", "https://")):
                # ⭐ 这版 bilibili_api 的异步加载方法是 Picture.load_url；
                #    原来写的 Picture.async_from_url 根本不存在 ⇒ URL 图一直静默失败（被 except 吞掉）。
                pic = await Picture.load_url(img_path)
            else:
                if not os.path.isfile(img_path):
                    raise ValueError(f"图片文件不存在: {img_path}")
                pic = Picture.from_file(img_path)
            dyn.add_image(pic)
        if topic_id:
            dyn.set_topic(topic_id)
        if schedule_time > 0:
            dyn.set_send_time(schedule_time)
    except asyncio.CancelledError:
        guard.release(reservation)  # Publication has not started during preparation.
        raise
    except Exception as exc:
        guard.release(reservation)
        return json.dumps({"success": False, "error": str(exc), "guard_status": "not_sent",
                           "retry_blocked": False}, ensure_ascii=False)

    async def _send():
        return await dynamic.send_dynamic(info=dyn, credential=cred)

    outcome = await _guarded_send(guard, reservation, _send)
    if outcome["guard_status"] != "sent":
        payload = {name: value for name, value in outcome.items() if name != "result"}
        payload.update(success=False, already_replied=outcome["guard_status"] == "unknown")
        return json.dumps(payload, ensure_ascii=False)
    result = outcome["result"]
    return json.dumps({"success": True, "message": "动态发布成功", "guard_status": "sent",
                       "data": stringify_ids(result) if isinstance(result, dict) else str(result)}, ensure_ascii=False)


# ========== Tool 9: 上传视频 ==========

@tool()
async def bili_upload_video(
    video_path: str,
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
    dynamic_text: str = "",
    no_reprint: bool = True,
) -> str:
    """
    上传视频到B站

    Args:
        video_path: 视频文件的本地路径
        title: 视频标题（最多80字）
        desc: 视频简介描述
        tid: 分区ID，默认124（趣味科普人文-社科·法律·心理）。
             常用分区：17=单机游戏 21=日常 95=数码 122=野生技术协会
             124=社科 160=生活记录 171=电子竞技 183=影视杂谈
             188=科技资讯 201=科学 207=财经商业 208=科技 209=手工
             230=其他(生活) 231=美食 234=健身 32=完结动画
        tags: 标签，逗号分隔，如"AI,教程,编程"（至少1个标签）
        cover_path: 封面图片路径（可选，不填则B站自动截取）
        source: 转载来源URL（非原创时必填）
        dynamic_text: 粉丝动态文本（可选，投稿时同步发布的动态内容）
        no_reprint: 是否启用未经作者授权禁止转载，默认True

    Returns:
        上传结果，包含BV号
    """
    # ---- 参数校验 ----
    if not video_path or not video_path.strip():
        return json.dumps({"success": False, "error": "video_path 不能为空，请提供视频文件的本地路径"}, ensure_ascii=False)

    video_path = video_path.strip()
    if not os.path.isfile(video_path):
        return json.dumps({"success": False, "error": f"视频文件不存在: {video_path}"}, ensure_ascii=False)

    if not title or not title.strip():
        return json.dumps({"success": False, "error": "title 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    try:
        # 准备分P
        page = VideoUploaderPage(
            path=video_path,
            title=title.strip()[:80],
            description=(desc or "")[:250],
        )

        # 标签处理
        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
        if not tag_list:
            tag_list = ["视频"]

        # 判断原创/转载
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 自动从视频截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(video_path)

        meta = VideoMeta(
            tid=tid,
            title=title.strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
            no_reprint=no_reprint if is_original else False,
            dynamic=dynamic_text.strip() if dynamic_text and dynamic_text.strip() else None,
        )

        uploader = VideoUploader(
            pages=[page],
            meta=meta,
            credential=cred,
        )

        # 上传事件回调（记录进度）
        progress_info = {"phase": "初始化"}

        @uploader.on("__ALL__")
        async def on_event(data: dict):
            progress_info["phase"] = str(data)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": "视频上传成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "last_phase": progress_info.get("phase", "unknown") if "progress_info" in dir() else "init",
        }, ensure_ascii=False)


# ========== Tool 10: 上传多P视频 ==========

@tool()
async def bili_upload_video_multi(
    video_paths: list[str],
    page_titles: list[str],
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
) -> str:
    """
    上传多P视频到B站（多个分P合并为一个投稿）

    Args:
        video_paths: 视频文件路径列表，如["/path/p1.mp4", "/path/p2.mp4"]
        page_titles: 各分P标题列表，与video_paths一一对应
        title: 视频总标题
        desc: 视频简介
        tid: 分区ID，默认124
        tags: 标签，逗号分隔
        cover_path: 封面图片路径（可选）
        source: 转载来源URL（非原创时必填）

    Returns:
        上传结果
    """
    cred = get_cred()

    if not video_paths:
        return json.dumps({"success": False, "error": "video_paths 不能为空"}, ensure_ascii=False)
    if not page_titles:
        return json.dumps({"success": False, "error": "page_titles 不能为空"}, ensure_ascii=False)
    if len(video_paths) != len(page_titles):
        return json.dumps({"success": False, "error": "video_paths 和 page_titles 数量必须一致"}, ensure_ascii=False)

    try:
        pages = []
        for i, vp in enumerate(video_paths):
            vp = (vp or "").strip()
            if not vp or not os.path.isfile(vp):
                return json.dumps({"success": False, "error": f"文件不存在: {vp}"}, ensure_ascii=False)
            pages.append(VideoUploaderPage(
                path=vp,
                title=(page_titles[i] or "").strip()[:80] or f"P{i+1}",
                description="",
            ))

        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()] or ["视频"]
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 从第一个视频自动截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(pages[0].path)

        meta = VideoMeta(
            tid=tid,
            title=(title or "").strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
        )

        uploader = VideoUploader(pages=pages, meta=meta, credential=cred)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": f"多P视频上传成功（共{len(pages)}P）",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 11: 发布专栏文章 (Opus) ==========

@tool()
async def bili_send_opus(
    title: str,
    content: str,
    images: list[str] | None = None,
    category_id: int = 0,
) -> str:
    """
    发布B站图文（Opus，新版专栏）

    Args:
        title: 文章标题
        content: 文章正文内容（纯文本，段落用换行分隔）
        images: 文章中插入的图片路径或URL列表（可选）
        category_id: 分类ID（可选，0表示不指定）

    Returns:
        发布结果
    """
    image_paths = [str(path).strip() for path in (images or []) if str(path or "").strip()]
    guard = _get_runtime_guard()
    reservation = guard.reserve_send(key_moment("opus", {
        "title": title, "content": content, "images": image_paths, "category_id": str(category_id),
    }))
    if not reservation["allowed"]:
        return _guard_blocked(reservation)
    try:
        cred = get_cred()
        dyn = dynamic.BuildDynamic.empty()
        dyn.add_plain_text(f"【{title}】\n\n{content}")
        for img_path in image_paths:
            try:
                if img_path.startswith(("http://", "https://")):
                    pic = await Picture.load_url(img_path)  # ⭐ async_from_url 不存在于本版本
                else:
                    pic = Picture.from_file(img_path)
                dyn.add_image(pic)
            except Exception:
                pass  # Preserve existing behavior: a bad article image does not prevent publication.
    except asyncio.CancelledError:
        guard.release(reservation)
        raise
    except Exception as exc:
        guard.release(reservation)
        return json.dumps({"success": False, "error": str(exc), "guard_status": "not_sent",
                           "retry_blocked": False}, ensure_ascii=False)

    async def _send():
        return await dynamic.send_dynamic(info=dyn, credential=cred)

    outcome = await _guarded_send(guard, reservation, _send)
    if outcome["guard_status"] != "sent":
        payload = {name: value for name, value in outcome.items() if name != "result"}
        payload.update(success=False, already_replied=outcome["guard_status"] == "unknown")
        return json.dumps(payload, ensure_ascii=False)
    result = outcome["result"]
    return json.dumps({"success": True, "message": "图文发布成功", "guard_status": "sent",
                       "data": stringify_ids(result) if isinstance(result, dict) else str(result)}, ensure_ascii=False)


# ========== Tool 12: 查询分区列表 ==========

@tool()
async def bili_video_zones() -> str:
    """
    获取B站视频常用分区ID列表，供上传视频时选择tid参数

    Returns:
        常用分区ID及名称
    """
    zones = {
        "科技": {
            188: "科技资讯", 122: "野生技术协会", 95: "数码",
            208: "科技", 209: "手工",
        },
        "知识": {
            201: "科学", 124: "社科·法律·心理", 207: "财经商业",
            228: "人文历史", 36: "科技(知识)",
        },
        "生活": {
            21: "日常", 160: "生活记录", 230: "其他",
            231: "美食", 234: "健身", 161: "搞笑",
        },
        "游戏": {
            17: "单机游戏", 171: "电子竞技", 172: "手机游戏",
            65: "网络游戏",
        },
        "影视": {
            183: "影视杂谈", 138: "搞笑", 182: "影视剪辑",
        },
        "动画": {
            32: "完结动画", 33: "连载动画", 51: "MAD·AMV",
        },
        "音乐": {
            28: "原创音乐", 31: "翻唱", 59: "演奏",
        },
    }
    return json.dumps(zones, ensure_ascii=False)


# ========================================================================
#                        V1.2 — 数据分析 & 互动运营
# ========================================================================


# ========== Tool 13: 热门视频 ==========

@tool()
async def bili_hot_videos(pn: int = 1, ps: int = 20) -> str:
    """
    获取B站当前热门视频列表

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认20，最大50

    Returns:
        热门视频列表，包含标题、播放量、UP主等
    """
    result = await hot.get_hot_videos(pn=pn, ps=min(ps, 50))
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "desc": (item.get("desc", "") or "")[:100],
            "duration": item.get("duration", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"page": pn, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 14: 热搜关键词 ==========

@tool()
async def bili_hot_buzzwords(page_num: int = 1, page_size: int = 20) -> str:
    """
    获取B站热搜词/热门关键词

    Args:
        page_num: 页码，默认1
        page_size: 每页数量，默认20

    Returns:
        热搜词列表
    """
    result = await hot.get_hot_buzzwords(page_num=page_num, page_size=page_size)
    return json.dumps(stringify_ids(result), ensure_ascii=False)


# ========== Tool 15: 每周必看 ==========

@tool()
async def bili_weekly_hot(week: int = 0) -> str:
    """
    获取B站每周必看视频推荐

    Args:
        week: 期数（0表示获取期数列表，>0表示获取该期的视频）

    Returns:
        每周必看期数列表或指定期的视频列表
    """
    if week <= 0:
        result = await hot.get_weekly_hot_videos_list()
        return json.dumps(stringify_ids(result), ensure_ascii=False)
    else:
        result = await hot.get_weekly_hot_videos(week=week)
        return json.dumps(stringify_ids(result), ensure_ascii=False)


# ========== Tool 16: 排行榜 ==========

@tool()
async def bili_rank(category: str = "all", day: int = 3) -> str:
    """
    获取B站各分区排行榜

    Args:
        category: 分区名，可选值：
            all=全站 original=原创 rookie=新人
            douga=动画 music=音乐 dance=舞蹈 game=游戏
            knowledge=知识 technology=科技 sports=运动 car=汽车
            life=生活 food=美食 animal=动物 fashion=时尚
            ent=娱乐 cinephile=影视
        day: 时间维度，3=三日 7=七日

    Returns:
        排行榜视频列表
    """
    type_map = {
        "all": rank.RankType.All, "original": rank.RankType.Original,
        "rookie": rank.RankType.Rookie, "douga": rank.RankType.Douga,
        "music": rank.RankType.Music, "dance": rank.RankType.Dance,
        "game": rank.RankType.Game, "knowledge": rank.RankType.Knowledge,
        "technology": rank.RankType.Technology, "sports": rank.RankType.Sports,
        "car": rank.RankType.Car, "life": rank.RankType.Life,
        "food": rank.RankType.Food, "animal": rank.RankType.Animal,
        "fashion": rank.RankType.Fashion, "ent": rank.RankType.Ent,
        "cinephile": rank.RankType.Cinephile,
    }
    day_map = {3: rank.RankDayType.THREE_DAY, 7: rank.RankDayType.WEEK}

    rank_type = type_map.get(category.lower(), rank.RankType.All)
    rank_day = day_map.get(day, rank.RankDayType.THREE_DAY)

    result = await rank.get_rank(type_=rank_type, day=rank_day)
    videos = []
    for idx, item in enumerate(result.get("list", []), start=1):
        stat = item.get("stat", {})
        videos.append({
            "rank": idx,
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "mid": item.get("owner", {}).get("mid", 0),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "coin": stat.get("coin", 0),
            # ⚠️ 榜单接口本身常常不返回 score（恒 0）⇒ 别让模型把它当"热度分"解读，
            #    真要判热度看 play/like。这里给 duration 和 pubdate 更有用。
            # ⚠️ `score` 实测恒 0（榜单接口本身就不返回）⇒ 原样留着当"没有就是没有"，
            #    但**永远别让模型拿它当热度读**。真要判热度：play / like / coin + rank 位次。
            "score": item.get("score", 0),
            "score_usable": bool(item.get("score", 0)),
            "duration": item.get("duration", 0),
            "pubdate": item.get("pubdate", 0),
            "pubdate_str": ts_to_day(item.get("pubdate", 0)),
            "days_ago": _days_ago(item.get("pubdate", 0)),
            "tname": item.get("tname", ""),
        })
    return json.dumps({
        "category": category, "day": day, "count": len(videos),
        # ⭐ 明写一句：榜单的 score 常为 0，别让模型把它当热度分做判断
        "note": "按榜单位次排（rank）。score 字段榜单独测常为 0，判热度请看 play/like/coin。",
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 17: 用户信息 ==========

@tool()
async def bili_user_info(uid: IdInput) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    try:
        uid = normalize_id(uid, allow_zero=False)
    except (TypeError, ValueError) as e:
        return json.dumps({"error": str(e), "invalid_id": True}, ensure_ascii=False)
    cred = get_cred()
    u = user.User(uid=int(uid), credential=cred)
    info = await u.get_user_info()

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except:
        pass

    relation = {}
    try:
        relation = await u.get_relation_info()
    except:
        pass

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)


# ========== Tool 18: 用户视频列表 ==========

@tool()
async def bili_user_videos(uid: IdInput, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    try:
        uid = normalize_id(uid, allow_zero=False)
    except (TypeError, ValueError) as e:
        return json.dumps({"error": str(e), "invalid_id": True}, ensure_ascii=False)
    cred = get_cred()
    u = user.User(uid=int(uid), credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    videos = []
    for idx, item in enumerate(result.get("list", {}).get("vlist", []), start=1):
        created = item.get("created", 0)
        videos.append({
            "no": idx,
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": created,
            # ⭐ 补上人能读的日期 + 有多少天前的：光给 created=1792438295，
            #   模型判断不了"这是不是上周的"，就只能瞎猜（和 bili_search 当初的毛病一样）。
            "created_str": ts_to_day(created),
            "days_ago": _days_ago(created),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 18b: 关注列表（鲸鱼号书单发现用） ==========

@tool()
async def bili_followings(uid: IdInput = "", pn: int = 1, ps: int = 50, attention: bool = False, all_pages: bool = False) -> str:
    """
    获取B站用户关注列表（自己账号可全量；别人账号只能看前 5 页）

    Args:
        uid: 用户UID（留空 = 当前登录的鲸鱼号自己）
        pn: 页码，从 1 开始
        ps: 每页条数（默认 50，最大 50）
        attention: True=按「最常访问」排序；False=按关注顺序
        all_pages: True=自动翻页拉全量（仅自己账号；最多 40 页 / 2000 个）

    Returns:
        ok / uid / self / total / pages_fetched / is_end / list[{mid, uname, sign, mtime, followed_days_ago}]
    """
    cred = get_cred()
    self_uid = str(getattr(cred, "dedeuserid", "") or "").strip()
    if not self_uid:
        return json.dumps({"ok": False, "error": "登录凭证里没有 dedeuserid，无法确定本账号 UID"}, ensure_ascii=False)
    if uid in (None, ""):
        target = self_uid
    else:
        try:
            target = normalize_id(uid, allow_zero=False)
        except (TypeError, ValueError) as e:
            return json.dumps({"ok": False, "error": str(e), "invalid_id": True}, ensure_ascii=False)
    is_self = str(target) == self_uid
    page_size = max(1, min(int(ps or 50), 50))
    if not all_pages:
        max_pages = 1
    else:
        max_pages = 40 if is_self else 5
    u = user.User(uid=int(target), credential=cred)
    rows, fetched, is_end, total = [], 0, False, 0
    try:
        start_page = max(1, int(pn or 1))
        for i in range(max_pages):
            data = await u.get_followings(pn=start_page + i, ps=page_size, attention=attention)
            fetched += 1
            page = (data or {}).get("page") or {}
            total = max(total, int(page.get("total") or 0))
            items = (data or {}).get("list") or []
            for item in items:
                mtime = int(item.get("mtime") or 0)
                rows.append({
                    "mid": str(item.get("mid") or ""),
                    "uname": str(item.get("uname") or ""),
                    "sign": str(item.get("sign") or "")[:120],
                    "mtime": mtime,
                    "followed_days_ago": _days_ago(mtime),
                    "attribute": int(item.get("attribute") or 0),
                })
            is_end = bool(page.get("is_end")) or not items
            if is_end or not all_pages or len(rows) >= 2000:
                break
            await asyncio.sleep(0.35)
    except Exception as e:  # noqa: BLE001 —— 固定脚本必须结构化失败
        return json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False)
    return json.dumps({
        "ok": True,
        "uid": str(target),
        "self": is_self,
        "total": total,
        "pages_fetched": fetched,
        "is_end": is_end,
        "count": len(rows),
        "list": rows,
    }, ensure_ascii=False)


# ========== Tool 18c: 补关注（写动作） ==========

@tool()
async def bili_follow(mid: IdInput) -> str:
    """关注一个 UP 主（写动作；当前登录账号身份）。已关注/互关时幂等返回 already=true。

    Args:
        mid: 要关注的用户 UID
    """
    cred = get_cred()
    try:
        target = int(normalize_id(mid, allow_zero=False))
    except (TypeError, ValueError) as e:
        return json.dumps({"ok": False, "error": str(e), "invalid_id": True}, ensure_ascii=False)
    u = user.User(uid=target, credential=cred)
    name = ""
    try:
        info = await u.get_user_info()
        name = str(info.get("name") or "")
    except Exception:
        pass
    try:
        rel = await u.get_relation_info()
        attribute = int(rel.get("attribute") or 0)
        if attribute in (2, 6):
            return json.dumps({"ok": True, "already": True, "followed": False, "mid": str(target), "uname": name, "attribute": attribute}, ensure_ascii=False)
    except Exception:
        pass
    try:
        await u.modify_relation(user.RelationType.SUBSCRIBE)
    except Exception as e:  # noqa: BLE001
        return json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e), "mid": str(target), "uname": name}, ensure_ascii=False)
    try:
        rel2 = await u.get_relation_info()
        attribute2 = int(rel2.get("attribute") or 0)
    except Exception:
        attribute2 = 0
    return json.dumps({"ok": True, "followed": True, "already": False, "mid": str(target), "uname": name, "attribute": attribute2}, ensure_ascii=False)


# ========== Tool 19: 收藏夹列表 ==========

@tool()
async def bili_favorite_lists(uid: int = 0) -> str:
    """
    获取用户的收藏夹列表

    Args:
        uid: 用户UID（0表示获取自己的收藏夹）

    Returns:
        收藏夹列表，包含ID、名称、视频数量
    """
    cred = get_cred()
    if uid == 0:
        # 从凭证获取自己的UID
        import json as _json
        with open(CRED_FILE) as f:
            data = _json.load(f)
        uid = int(data.get("dedeuserid", 0))

    result = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    fav_lists = []
    for item in (result.get("list", []) or []):
        fav_lists.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "media_count": item.get("media_count", 0),
            "fav_state": item.get("fav_state", 0),
        })
    return json.dumps({"uid": uid, "count": len(fav_lists), "lists": fav_lists}, ensure_ascii=False)


# ========== Tool 20: 收藏夹内容 ==========

@tool()
async def bili_favorite_content(media_id: int, page: int = 1, keyword: str = "") -> str:
    """
    获取收藏夹内的视频列表

    Args:
        media_id: 收藏夹ID（从 bili_favorite_lists 获取）
        page: 页码，默认1
        keyword: 搜索关键词（在收藏夹内搜索）

    Returns:
        收藏夹内的视频列表
    """
    cred = get_cred()
    result = await favorite_list.get_video_favorite_list_content(
        media_id=media_id,
        page=page,
        keyword=keyword if keyword else None,
        credential=cred,
    )
    medias = []
    for item in (result.get("medias", []) or []):
        medias.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("cnt_info", {}).get("play", 0),
            "collect": item.get("cnt_info", {}).get("collect", 0),
            "author": item.get("upper", {}).get("name", ""),
            "duration": item.get("duration", 0),
            "fav_time": item.get("fav_time", 0),
        })
    return json.dumps({
        "media_id": media_id,
        "page": page,
        "has_more": result.get("has_more", False),
        "count": len(medias),
        "medias": medias,
    }, ensure_ascii=False)


# ========== Tool 21: 发私信 ==========

@tool()
async def bili_send_message(receiver_uid: IdInput, text: str, msg_seqno: IdInput = "0") -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容
        msg_seqno: 对方那条消息的序号（有就传 —— 判重按「谁的第几条」记最准；没有就按内容哈希记）

    Returns:
        发送结果（带 guard_status）
    """
    try:
        receiver_uid = normalize_id(receiver_uid, allow_zero=False)
        msg_seqno = normalize_id(msg_seqno)
    except (TypeError, ValueError) as e:
        return json.dumps({"success": False, "error": str(e), "invalid_id": True,
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    body = (text or "").strip()
    if not body:
        return json.dumps({"success": False, "error": "text 不能为空",
                           "guard_status": "not_sent"}, ensure_ascii=False)

    try:
        cred = get_cred()
    except Exception as e:
        return json.dumps({"success": False, "error": str(e),
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)

    guard = _get_runtime_guard()
    try:
        key = key_dm_reply(receiver_uid, body, msg_seqno)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e),
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    reservation = guard.reserve_send(key, legacy_dm_keys(msg_seqno))
    if not reservation.get("allowed"):
        return _guard_blocked(reservation, "send", f"这条私信已经回过了（UID:{receiver_uid}）")

    async def _send():
        return await session.send_msg(
            credential=cred,
            receiver_id=int(receiver_uid),
            msg_type=session.EventType.TEXT,
            content=body,
        )

    outcome = await _guarded_send(guard, reservation, _send, {"uid": receiver_uid, "msg_seqno": msg_seqno})
    if outcome["guard_status"] != "sent":
        payload = {
            "success": False,
            "error": outcome["error"],
            "code": outcome.get("code"),
            "guard_status": outcome["guard_status"],
            "retry_blocked": outcome["retry_blocked"],
            "already_replied": outcome["guard_status"] == "unknown",
        }
        payload.update({name: outcome[name] for name in ("pace", "reason", "pace_kind", "retry_at", "retryAt",
                        "wait_ms", "waitMs", "wait_seconds", "waitSec") if name in outcome})
        if outcome.get("limit_reached"):
            payload["limit_reached"] = True
            payload["limit_kind"] = outcome.get("limit_kind") or "comment"
        return json.dumps(payload, ensure_ascii=False)
    result = outcome["result"]
    return json.dumps({
        "success": True,
        "message": f"私信已发送给UID:{receiver_uid}",
        "guard_status": "sent",
        "data": result if isinstance(result, dict) else str(result),
    }, ensure_ascii=False)


# ========== Tool 21.1: 私信会话列表（收件箱） ==========

# 昵称缓存：`get_sessions` 只给 UID 不给名字，得再摸一次用户信息。
# 一个会话列表可能十几个 talker ⇒ 每次全量请求既慢又容易撞风控，缓存住（进程生命周期内有效）。
_DM_NAME_CACHE: dict[int, str] = {}


async def _dm_nickname(uid: int, cred: Credential) -> str:
    """UID → 昵称；查不到就给空串（**绝不抛错** —— 名字只是好看，不能因为它毁掉整个列表）。"""
    if not uid:
        return ""
    hit = _DM_NAME_CACHE.get(uid)
    if hit is not None:
        return hit
    try:
        info = await user.User(uid, credential=cred).get_user_info()
        name = (info or {}).get("name") or ""
    except Exception:
        name = ""
    _DM_NAME_CACHE[uid] = name
    return name


def _dm_text_of(msg: dict) -> str:
    """把私信 `content`（一个 JSON 字符串）拆成人能读的一句话。

    真机形状（2026-10-20 抓的）：
      · msg_type 1 文本 → `{"content":"hi"}`
      · msg_type 10/系统通知 → `{"title":…,"text":…,"modules":[…]}`（会话里的「社区中心」就是这种）
      · 图片 / 分享卡片是另外的键
    拿不到就退化成原串（宁可难看也别丢内容）。
    """
    raw = msg.get("content")
    if isinstance(raw, dict):
        obj = raw
    else:
        try:
            obj = json.loads(raw or "{}")
        except (TypeError, ValueError):
            return str(raw or "")[:300]
    if not isinstance(obj, dict):
        return str(obj)[:300]
    for key in ("content", "text", "title", "desc"):
        v = obj.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()[:300]
    return ""


def _ts_to_str(ts) -> str:
    """unix 秒 → `YYYY-MM-DD HH:MM`；拿不到给空串。"""
    from datetime import datetime
    try:
        return datetime.fromtimestamp(int(ts)).strftime("%Y-%m-%d %H:%M") if ts else ""
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


@tool()
async def bili_dm_list(num: int = 10) -> str:
    """
    看B站私信收件箱：谁给我发了私信、说了什么（只看「对方说的最后一句」）

    Args:
        num: 最多返回几条（默认 10）

    Returns:
        会话列表（含 msg_seqno —— 回完要靠它判重，别回第二遍）
    """
    cred = get_cred()
    try:
        result = await session.get_sessions(credential=cred, session_type=1)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)

    sessions = result.get("session_list") if isinstance(result, dict) else None
    if not isinstance(sessions, list):
        return json.dumps(stringify_ids(result), ensure_ascii=False)

    out = []
    for s in sessions:
        if not isinstance(s, dict):
            continue
        # 系统号（社区中心 / 登录通知 / 客服）不是「人」⇒ 一律不看：
        #   · session_type 不是 1 的不是私聊
        #   · 带 account_info / system_msg_type / notify_code 的是官方号
        #   · msg_type 不是 1 的（10=系统通知，2=图片，7=分享）也别当聊天
        if s.get("session_type") != 1:
            continue
        if s.get("system_msg_type") or s.get("account_info"):
            continue
        last = s.get("last_msg") or {}
        if last.get("notify_code") or last.get("account_info"):
            continue
        if last.get("msg_type") != 1:
            continue
        talker = int(s.get("talker_id") or 0)
        sender = int(last.get("sender_uid") or 0)
        # ⭐ 只报「**对方最后说的那一句**」：最后一条是我们自己发的 ⇒ 已经回过了，不该再上榜。
        #    这也顺带成了一道天然判重（回完它就自动从列表里消失）。
        if not talker or sender != talker:
            continue
        seqno = int(last.get("msg_seqno") or 0)
        ts = int(last.get("timestamp") or 0)
        out.append({
            "uid": str(talker),                                   # 回他用 bili_send_message(receiver_uid=uid)
            "name": await _dm_nickname(talker, cred),
            "said": _dm_text_of(last),                       # 对方说的话 ← 要回的就是这个
            "msg_seqno": str(seqno),                              # ⭐ 判重靠它：这个 seqno 回过了就别再回
            "time": ts,
            "time_str": _ts_to_str(ts),
            "days_ago": _days_ago(ts),
            "unread": int(s.get("unread_count") or 0),
            "is_follow": bool(s.get("is_follow")),
        })

    # 新的排前面
    out.sort(key=lambda x: x["time"], reverse=True)
    out = out[:max(1, min(int(num or 10), 50))]
    return json.dumps({
        "count": len(out),
        "items": out,
        "hint": ("count=0 表示最近没有「对方说最后一句」的私信（正常结果，不是失败）" if not out else
                 "回一条：bili_send_message(receiver_uid=items[i].uid, text='…')。"
                 "每条都带 msg_seqno —— 那是判重的钥匙，回完记下来，同一个 seqno 别回两遍。"),
    }, ensure_ascii=False)


# ========== Tool 21.2: 某个人的私信往来 ==========

@tool()
async def bili_dm_thread(talker_id: IdInput, num: int = 20) -> str:
    """
    看和某个人的私信往来（最近约三十条，给判断上下文用）

    Args:
        talker_id: 对方 UID（从 bili_dm_list 的 items[].uid 拿）
        num: 最多返回几条（默认 20）

    Returns:
        消息列表（is_me=true 是我们自己说的）
    """
    try:
        talker_id = normalize_id(talker_id, allow_zero=False)
    except (TypeError, ValueError) as e:
        return json.dumps({"error": str(e), "invalid_id": True}, ensure_ascii=False)
    cred = get_cred()
    try:
        me = (await user.get_self_info(credential=cred) or {}).get("mid") or 0
    except Exception:
        me = 0
    try:
        result = await session.fetch_session_msgs(
            talker_id=int(talker_id), credential=cred, session_type=1,
        )
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)

    msgs = result.get("messages") if isinstance(result, dict) else None
    if not isinstance(msgs, list):
        return json.dumps(stringify_ids(result), ensure_ascii=False)

    out = []
    for m in msgs:
        if not isinstance(m, dict):
            continue
        sender = int(m.get("sender_uid") or 0)
        ts = int(m.get("timestamp") or 0)
        out.append({
            "is_me": bool(me) and sender == int(me),
            "sender_uid": str(sender),
            "text": _dm_text_of(m),
            "msg_type": int(m.get("msg_type") or 0),
            "msg_seqno": str(m.get("msg_seqno") or "0"),
            "time": ts,
            "time_str": _ts_to_str(ts),
        })
    out.sort(key=lambda x: x["time"])
    out = out[-max(1, min(int(num or 20), 50)):]
    return json.dumps({
        "talker_id": talker_id,
        "name": await _dm_nickname(int(talker_id), cred),
        "count": len(out),
        "items": out,
        "hint": "按时间从早到晚；is_me=true 的那几条是我们自己说的，别把它们当成对方的话来回复。",
    }, ensure_ascii=False)


# ========== Tool 22: 未读消息 ==========

@tool()
async def bili_unread_messages() -> str:
    """
    获取B站未读消息数（私信、@、回复、点赞等）

    Returns:
        各类未读消息数量
    """
    cred = get_cred()
    try:
        result = await session.get_unread_messages(credential=cred)
        return json.dumps(stringify_ids(result), ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 23: 最近收到的回复 ==========

@tool()
async def bili_received_replies() -> str:
    """
    获取最近收到的评论回复通知

    Returns:
        回复列表（含 count / items；count=0 就是"最近没人回你"，不是工具坏了）
    """
    cred = get_cred()
    try:
        result = stringify_ids(await session.get_replies(credential=cred))
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)
    # ⚠️ SDK 原样返回的是 `{cursor, items, last_view_at}` —— **没有 count 字段**，
    #    模型看到 items:[] 里没东西会怀疑"是不是没查成"。这里补一个显式 count，
    #    并把每条拍平成模型好读的形状（原结构嵌太深，读完要多花几百 token）。
    items = result.get("items") if isinstance(result, dict) else None
    if not isinstance(items, list):
        return json.dumps(stringify_ids(result), ensure_ascii=False)

    # ⭐⭐ 2026-10-20 真机抓回来的形状（此前所有字段名都猜错了，导致「count=4 但每条全空」
    #    —— 她看到了"4 条回复"，却读不到一个字，自然一条也回不了 ✗）。真实结构是三层：
    #      { id, user:{mid,nickname}, counts, is_multi, reply_time,
    #        item:{ subject_id(视频aid), root_id(她那层主评论 rpid), source_id(对方这条 rpid),
    #               target_id, type:"reply", business:"评论",
    #               title(她自己那条评论原文), source_content(对方说了啥 ← 最关键),
    #               root_reply_content, target_reply_content, uri("https://www.bilibili.com/video/BVxxxx") } }
    #    ⚠️ 没有 uname / message / bvid / ctime / rpid 这些名字，全在 item 里。
    flat = []
    for it in items:
        if not isinstance(it, dict):
            continue
        user = it.get("user") or {}
        item = it.get("item") or {}
        uri = item.get("uri") or ""
        bvid = uri.rsplit("/", 1)[-1].split("?")[0] if "/video/" in uri else ""
        if not bvid:
            # 老通知可能只带 native_uri（bilibili://video/<aid>?comment_root_id=…）
            nat = item.get("native_uri") or ""
            if "comment_root_id=" in nat:
                bvid = ""
        t = it.get("reply_time") or it.get("ctime") or 0
        root_id = item.get("root_id") or "0"
        source_id = item.get("source_id") or "0"
        flat.append({
            # ── 回复要用到的两个 id（缺一样都发不出去）
            "root_rpid": root_id,      # 她那层主评论：bili_reply 的 root
            "reply_rpid": source_id,   # 对方这条：bili_reply 的 rpid(parent)
            "oid": item.get("subject_id") or "0",
            "bvid": bvid,
            # ── 谁说了什么
            "user": user.get("nickname") or "",
            "uid": user.get("mid") or "0",
            "said": (item.get("source_content") or "").strip()[:300],   # 对方说的话 ← 回他就是要回这个
            "my_comment": (item.get("title") or "").strip()[:200],      # 被回的那条（她自己的）
            "title": (item.get("detail_title") or "").strip(),          # 视频标题（老接口常空）
            "time": t,
            "time_str": ts_to_day(t),
            "days_ago": _days_ago(t),
        })
    for f in flat:
        if f["said"]:
            f["how_to_reply"] = (
                f"bili_reply(bvid='{f['bvid']}', rpid='{f['reply_rpid']}', root='{f['root_rpid']}', text='…')"
                if f["reply_rpid"] not in ("", "0") else
                f"bili_reply(bvid='{f['bvid']}', rpid='{f['root_rpid']}', text='…')"
            )
    return json.dumps({
        "count": len(flat),
        "items": flat,
        "last_view_at": result.get("last_view_at", 0),
        # ⭐ 空列表 ≠ 出错：明写一句，省得模型为一封"没人回"的通知反复重试
        "hint": ("count=0 表示最近没人回复你的评论（正常结果，不是失败）" if not flat else
                 "每条都给了 how_to_reply：照抄那段、只换 text 就能回给他（root 是她那层主评论，rpid 是对方这条）"),
    }, ensure_ascii=False)


# ========== Tool 24: 最近收到的@和点赞 ==========

@tool()
async def bili_received_at_and_likes() -> str:
    """
    获取最近收到的@提及和点赞通知

    Returns:
        包含 at 和 likes 两部分的通知数据
    """
    cred = get_cred()
    result = {}
    try:
        result["at"] = await session.get_at(credential=cred)
    except Exception as e:
        result["at_error"] = str(e)
    try:
        result["likes"] = await session.get_likes(credential=cred)
    except Exception as e:
        result["likes_error"] = str(e)
    return json.dumps(stringify_ids(result), ensure_ascii=False)


# ========== Tool 25: 点赞 / @ 通知（拍平版） ==========

def _notice_user(u) -> dict:
    """通知里的用户对象只留要用的三样（原始对象带头像链接/粉丝数，白占 token）。"""
    if not isinstance(u, dict):
        return {"uid": 0, "name": ""}
    return {"uid": u.get("mid") or 0, "name": u.get("nickname") or ""}


@tool()
async def bili_my_notices(num: int = 10) -> str:
    """
    看最近谁赞了你、谁 @ 了你（拍平成一行一条）

    Args:
        num: 各取几条（默认 10，最多 30）

    Returns:
        点赞 / @ 两部分；count=0 是"最近没人赞/没人@"，不是工具坏了
    """
    cred = get_cred()
    n = max(1, min(int(num or 10), 30))
    out = {"likes": [], "ats": []}

    # ① 点赞：session.get_likes() → {total:{items:[{users:[…], item:{…}, counts, like_time}]}, latest:{…}}
    #    ⚠️ 一条通知里 users 是**一批人**（B站 把连着的赞合并成一条），counts 才是真赞数。
    try:
        lk = await session.get_likes(credential=cred)
        raw = ((lk.get("total") or {}).get("items")) or []
        # 按时间倒序取最新 n 条
        raw = sorted([x for x in raw if isinstance(x, dict)],
                     key=lambda x: x.get("like_time") or 0, reverse=True)[:n]
        for x in raw:
            item = x.get("item") or {}
            users = [_notice_user(u) for u in (x.get("users") or [])]
            t = x.get("like_time") or 0
            out["likes"].append({
                "count": x.get("counts") or 0,        # 这一条通知合并了几个赞
                "users": users[:3],                   # 名字只给前三个，别让模型读一串名单
                "user": (users[0]["name"] if users else ""),
                "uid": (users[0]["uid"] if users else 0),
                "business": item.get("business") or "",   # "评论" / "动态"
                "type": item.get("type") or "",
                "title": (item.get("title") or "").strip()[:200],   # 被赞的那条（她自己写的）
                "uri": item.get("uri") or "",
                "item_id": item.get("item_id") or 0,  # 被赞的 rpid（想再点进去看用得上）
                "time": t,
                "time_str": ts_to_day(t),
                "days_ago": _days_ago(t),
            })
    except Exception as e:
        out["likes_error"] = str(e)

    # ② @ 我：session.get_at() → {cursor, items:[{id, user, at_time, item:{…}}]}
    try:
        at = await session.get_at(credential=cred)
        raw = (at.get("items") if isinstance(at, dict) else None) or []
        raw = sorted([x for x in raw if isinstance(x, dict)],
                     key=lambda x: x.get("at_time") or 0, reverse=True)[:n]
        for x in raw:
            item = x.get("item") or {}
            u = _notice_user(x.get("user"))
            uri = item.get("uri") or ""
            t = x.get("at_time") or 0
            out["ats"].append({
                "user": u["name"],
                "uid": u["uid"],
                "said": (item.get("source_content") or "").strip()[:300],
                # @ 可能在视频、动态、专栏下面 —— 只给出处，不猜类型（猜错会让它去回错地方）
                "uri": uri,
                "bvid": uri.rsplit("/", 1)[-1].split("?")[0] if "/video/" in uri else "",
                "opus_id": uri.split("/opus/")[-1].split("#")[0] if "/opus/" in uri else "",
                "business": item.get("business") or "",
                "title": (item.get("title") or "").strip()[:200],
                "time": t,
                "time_str": ts_to_day(t),
                "days_ago": _days_ago(t),
            })
    except Exception as e:
        out["ats_error"] = str(e)

    out["count"] = len(out["likes"]) + len(out["ats"])
    # ⚠️ 用 .get()：两个都成功时这两个键**根本不存在**（2026-10-20 踩过一次 KeyError，
    #    工具直接崩成一堆 traceback，模型只会看到"这个工具坏了"）
    if out.get("likes_error") and out.get("ats_error"):
        return json.dumps({"error": "点赞和 @ 都没取到：" + out["likes_error"]}, ensure_ascii=False)
    # 一句人话给模型：它不需要重试一封"没人赞"的通知
    out["hint"] = ("最近没人赞也没人 @ 你（正常结果，不是失败）" if out["count"] == 0 else
                   "likes 里 count 是合并后的真赞数、title 是被赞的那条你自己写的评论；ats 里 said 是对方 @ 你说的那句话")
    return json.dumps(stringify_ids(out), ensure_ascii=False)


# ========== Tool 26: 回动态（opus）下面的评论 ==========

_OPUS_TYPE = {
    # basic.comment_type → CommentResourceType
    # 11 = 图文动态（真机验过），17 = 纯文字动态，1 = 视频，12 = 专栏
    11: comment.CommentResourceType.DYNAMIC_DRAW,
    17: comment.CommentResourceType.DYNAMIC,
    1: comment.CommentResourceType.VIDEO,
    12: comment.CommentResourceType.ARTICLE,
    14: comment.CommentResourceType.AUDIO,
}


async def _opus_comment_target(dynamic_id, cred) -> dict:
    """把「动态 id」翻译成「能评论的 oid + 评论区类型」。

    ⚠️ 动态没有 BV 号：`bilibili.com/opus/<id>` 里那串是 **dynamic_id**，
       而评论接口要 `item.basic.comment_id_str`（另一串数字）＋ `comment_type`。
       拿 dynamic_id 直接当 oid 打评论接口恒 -404（"啥都木有"）—— 2026-10-20 踩过。

    🔴🔴 **第二坑（2026-10-20 修）：opus_id 是 19 位大数（约 1.26e18），超过 JS 的
       `Number.MAX_SAFE_INTEGER`（9007199254740991 ≈ 9.0e15）**。宿主是 Node，只要
       中间经过一次 `Number()` / JSON 的 number 解析，末几位就被抹平：
       `1261215102078550023` → `1261215102078550016` ⇒ B站 只会说「没这条动态」。
       所以**整条链路（宿主传参 / 本函数 / 返回值）一律用字符串走**，
       这里只做 `int(str(x))` —— 字符串进来是精确的，转 int 也还是精确的。
    """
    # 收字符串也收 int：字符串优先（精确），int 只在调用方本来就是 Python 精确值时才安全
    did = int(normalize_id(dynamic_id, allow_zero=False))
    d = dynamic.Dynamic(dynamic_id=did, credential=cred)
    info = await d.get_info()
    item = info.get("item") or {}
    basic = item.get("basic") or {}
    mods = item.get("modules") or {}
    cid = basic.get("comment_id_str")
    ctype = basic.get("comment_type")
    if not cid:
        raise RuntimeError("这条动态没有评论区（comment_id_str 为空）")
    return {
        "oid": int(cid),
        "ctype": int(ctype or 11),
        "resource": _OPUS_TYPE.get(int(ctype or 11), comment.CommentResourceType.DYNAMIC_DRAW),
        "author_mid": (mods.get("module_author") or {}).get("mid") or 0,
        "dynamic_id": did,
    }


@tool()
async def bili_opus_comments(opus_id: IdInput, num: int = 10) -> str:
    """
    看一条动态（opus）下面有什么评论

    Args:
        opus_id: 动态 id（就是 `bilibili.com/opus/<这串数字>` 里那串，或 bili_my_notices 的 opus_id）。
                 ⚠️ 它是 19 位大数，**请当字符串原样传**（传 number 在 JS 那侧会掉精度，末几位变 0）
        num: 取几条（默认 10，最多 30）

    Returns:
        评论列表（含 rpid / 谁说的 / 说了什么）；count=0 是"这条动态还没人评论"
    """
    try:
        oid_str = normalize_id(opus_id, allow_zero=False)
    except (TypeError, ValueError) as e:
        return json.dumps({"error": str(e), "invalid_id": True}, ensure_ascii=False)
    cred = get_cred()
    try:
        tgt = await _opus_comment_target(oid_str, cred)
    except Exception as e:
        return json.dumps({"error": f"取不到这条动态的评论区：{e}"}, ensure_ascii=False)
    try:
        r = await comment.get_comments(oid=tgt["oid"], type_=tgt["resource"], credential=cred)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)

    me = await _self_mid(cred)
    r = stringify_ids(r)
    reps = [x for x in (r.get("replies") or []) if isinstance(x, dict)]
    reps = reps[: max(1, min(int(num or 10), 30))]
    items = []
    for x in reps:
        mem = x.get("member") or {}
        mid = int(mem.get("mid") or 0)
        t = x.get("ctime") or 0
        items.append({
            "rpid": x.get("rpid_str") or x.get("rpid") or "0",
            "root": x.get("root") or "0",       # 0 = 直接评在这条动态下面
            "parent": x.get("parent") or "0",
            "is_me": mid == me,
            "uid": str(mid),
            "user": mem.get("uname") or "",
            "said": str((x.get("content") or {}).get("message") or "").strip()[:300],
            "rcount": x.get("rcount") or 0,    # 这条下面还有几条回复
            "like": x.get("like") or 0,
            "time": t,
            "time_str": ts_to_day(t),
            "days_ago": _days_ago(t),
        })
    for it in items:
        if not it["is_me"]:
            # 动态评论没有 bvid：要靠 bili_reply_opus(opus_id, rpid, root, text)
            # ⚠️ opus_id 用带引号的字符串写进提示，免得模型照着抄成 number 又掉精度
            it["how_to_reply"] = f"bili_reply_opus(opus_id='{oid_str}', rpid='{it['rpid']}', root='{it['root']}', text='…')"
    return json.dumps({
        # ⭐ 回字符串：宿主是 JS，number 会在 1e18 这一档直接掉精度（末几位变 0）
        "opus_id": oid_str,
        "opus_id_is_string": True,
        "count": len(items),
        "items": items,
        "hint": ("这条动态下面还没有评论（正常结果）" if not items else
                 "动态没有 BV 号，别用 bili_reply —— 用 how_to_reply 里那只 bili_reply_opus"
                 "（opus_id 一定要原样带引号传字符串，别转成数字）"),
    }, ensure_ascii=False)


@tool()
async def bili_reply_opus(opus_id: IdInput, text: str, rpid: IdInput = "0", root: IdInput = "0") -> str:
    """
    回复动态（opus）下面的某条评论

    Args:
        opus_id: 动态 id（`bilibili.com/opus/<这串数字>`）。
                 ⚠️ 19 位大数，**必须当字符串传**（传 number 在 JS 那侧掉精度，
                    末几位变 0，B站 直接说"没这条动态"）
        text: 回复内容
        rpid: 要回的那条评论 id（0 = 直接在动态下面发一条新评论）
        root: 楼层根评论 id（回楼中楼时填；回一级评论时不用）

    Returns:
        发表结果（带 rpid 便于判重记账；带 guard_status）
    """
    try:
        oid_str = normalize_id(opus_id, allow_zero=False)
        rpid = normalize_id(rpid)
        root = normalize_id(root)
        if rpid == "0" and root != "0":
            raise ValueError("root requires a nonzero rpid")
    except (TypeError, ValueError) as e:
        return json.dumps({"success": False, "error": str(e), "invalid_id": True,
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    body = (text or "").strip()
    if not body:
        return json.dumps({"success": False, "error": "回复内容是空的",
                           "guard_status": "not_sent"}, ensure_ascii=False)
    try:
        cred = get_cred()
        tgt = await _opus_comment_target(oid_str, cred)
    except Exception as e:
        return json.dumps({"success": False, "error": f"取不到这条动态的评论区：{e}",
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)

    guard = _get_runtime_guard()
    try:
        key = key_opus_reply(oid_str, rpid)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e),
                           "guard_status": "not_sent", "retry_blocked": False}, ensure_ascii=False)
    # 新键是 opus-reply:<opus_id>:<rpid>；旧 unscoped/root 键只读兼容，
    # 否则升级那一刻，昨天回过的那些今天会再回一遍。
    # 🔁 2026-10-25（使用者报「回一个人一条评论两条消息」）：**视频通道回过的同号 rpid 也认**
    #    —— 同一条评论只回一次，不管上一次走的是 bili_reply 还是 bili_reply_opus。
    reservation = guard.reserve_send(key, [*legacy_opus_keys(rpid, root), *cross_channel_keys(rpid)])
    if not reservation.get("allowed"):
        return _guard_blocked(reservation, "send", "这条动态评论已经回过了")

    async def _send():
        if rpid == "0":
            return await comment.send_comment(
                text=body, oid=tgt["oid"], type_=tgt["resource"], credential=cred,
            )
        actual_root = int(root if root != "0" else rpid)
        return await comment.send_comment(
            text=body, oid=tgt["oid"], type_=tgt["resource"],
            root=actual_root, parent=int(rpid), credential=cred,
        )

    outcome = await _guarded_send(guard, reservation, _send, {"opus_id": oid_str, "rpid": rpid})
    if outcome["guard_status"] != "sent":
        payload = {
            "success": False,
            "error": outcome["error"],
            "code": outcome.get("code"),
            "guard_status": outcome["guard_status"],
            "retry_blocked": outcome["retry_blocked"],
            "already_replied": outcome["guard_status"] == "unknown",
        }
        payload.update({name: outcome[name] for name in ("pace", "reason", "pace_kind", "retry_at", "retryAt",
                        "wait_ms", "waitMs", "wait_seconds", "waitSec") if name in outcome})
        if outcome.get("limit_reached"):
            payload["limit_reached"] = True
            payload["limit_kind"] = outcome.get("limit_kind") or "comment"
        return json.dumps(payload, ensure_ascii=False)
    # ⭐ opus_id 一律回字符串（JS 侧 1e18 这一档 number 必掉精度，账本键会错）
    result = outcome["result"]
    out = {"success": True, "message": "动态评论回复成功", "guard_status": "sent",
           "opus_id": oid_str, "oid": str(tgt["oid"]), "ctype": tgt["ctype"]}
    if isinstance(result, dict):
        for name in ("rpid", "rpid_str", "root", "parent"):
            val = result.get(name)
            if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                out[name] = str(val)
    return json.dumps(stringify_ids(out), ensure_ascii=False)


@tool()
async def bili_my_dynamics(num: int = 10) -> str:
    """
    看我自己发过的动态（opus）—— 每条带 opus_id、有多少条评论、多少赞

    Args:
        num: 看几条（默认 10，最多 30）

    Returns:
        动态列表。⭐ 想知道"我发的动态下面有没有人说话"，就先用这只拿到 opus_id 和 comments 数，
        再对 comments > 0 的那些调 bili_opus_comments(opus_id)
    """
    cred = get_cred()
    try:
        me = await _self_mid(cred)
        if not me:
            return json.dumps({"error": "拿不到自己的 UID（登录态可能过期了）"}, ensure_ascii=False)
        r = await user.User(me, credential=cred).get_dynamics_new()
    except Exception as e:
        return json.dumps({"error": f"取不到我的动态列表：{e}"}, ensure_ascii=False)

    items = []
    for it in (r.get("items") or [])[: max(1, min(int(num or 10), 30))]:
        if not isinstance(it, dict):
            continue
        mods = it.get("modules") or {}
        md = mods.get("module_dynamic") or {}
        opus = ((md.get("major") or {}).get("opus") or {})
        summ = opus.get("summary") or {}
        desc = md.get("desc") or {}
        stat = mods.get("module_stat") or {}
        basic = it.get("basic") or {}
        # 正文可能放在两处：图文动态在 major.opus.summary.text，纯文字在 desc.text
        text = (summ.get("text") or desc.get("text") or "").strip()
        t = int((mods.get("module_author") or {}).get("pub_ts") or 0)
        cmt = (stat.get("comment") or {}).get("count")
        items.append({
            # ⭐ 一律字符串：opus_id 是 19 位大数，宿主（JS）number 在 1e18 这一档
            #    只能精确到 16 位 ⇒ 末几位被抹平成 0，再拿去查评论就是"没这条动态"。
            "opus_id": str(it.get("id_str") or "").strip(),
            "type": it.get("type") or "",
            "comments": int(cmt or 0),
            "likes": int(((stat.get("like") or {}).get("count")) or 0),
            "text": text[:160],
            "time": t,
            "time_str": ts_to_day(t),
            "days_ago": _days_ago(t),
            # 已经有人说话的动态才是该看的
            "has_comments": int(cmt or 0) > 0,
            # ⚠️ comment_id_str 是评论接口要的 oid，跟 opus_id 不是一回事（2026-10-20 踩过 -404）
            "_oid_hint": str(basic.get("comment_id_str") or ""),
        })
    for it in items:
        it.pop("_oid_hint", None)
        if it["has_comments"]:
            # 提示里带引号：模型照抄成 number 就会掉精度
            it["how_to_read"] = f"bili_opus_comments(opus_id='{it['opus_id']}')"
    return json.dumps({
        "count": len(items),
        "items": items,
        "hint": ("我还没发过动态（正常结果）" if not items else
                 "动态没有 BV 号：看评论用 bili_opus_comments、回评论用 bili_reply_opus，都别用 bili_reply"),
    }, ensure_ascii=False)


# ========== Tool 26b: 自己投稿下的评论（2026-10-21 使用者要求：第 0 步优先级最高） ==========

@tool()
async def bili_my_video_comments(num: int = 10, videos: int = 3) -> str:
    """
    看我自己投稿的视频下面有哪些评论 —— 这是「先回自己作品的评论」的唯一入口。

    ⭐ 为什么有这只：bili_received_replies 只拉「回复我的评论」的通知；自己投稿下的
    直接新评论（没 @ 我、没回我）不在任何通知里 ⇒ 以前第 0 步永远看不见它们。
    回复时用 bili_reply(bvid, rpid, root, text) —— 和回别人视频下的评论同一只工具。

    Args:
        num: 每个视频最多看几条评论（默认 10，最多 30，按时间倒序）
        videos: 查最近几个投稿（默认 3，最多 10）

    Returns:
        拍平的评论列表（跨视频）：rpid/root/aid/bvid 全是**字符串**（64 位大数，
        转 number 末几位会被抹成 0）——is_me=true 的是我自己发的楼，跳过别回。
    """
    cred = get_cred()
    try:
        me = await _self_mid(cred)
        if not me:
            return json.dumps({"error": "拿不到自己的 UID（登录态可能过期了）"}, ensure_ascii=False)
        # ⭐ get_videos 的返回：{"page": {...}, "list": {"vlist": [...]}}；vlist 默认按发布时间倒序
        vids = await user.User(me, credential=cred).get_videos(pn=1, ps=max(1, min(int(videos or 3), 10)))
        vlist = ((vids.get("list") or {}).get("vlist") or [])[: max(1, min(int(videos or 3), 10))]
    except Exception as e:
        return json.dumps({"error": f"取不到我的投稿列表：{e}"}, ensure_ascii=False)
    if not vlist:
        return json.dumps({
            "count": 0, "items": [], "videos": [],
            "hint": "我还没有投稿（正常结果，不算错）——第 0 步里这项直接跳过",
        }, ensure_ascii=False)

    items = []
    for v in vlist:
        # ⭐ aid 是 19 位大数（≈1.17e16 起跳），Python int 没问题，但**必须回字符串**给宿主
        aid = str(v.get("aid") or "")
        bvid = str(v.get("bvid") or "")
        title = str(v.get("title") or "")
        try:
            sec = await comment.get_comments(
                int(aid), comment.CommentResourceType.VIDEO, 1,
                comment.OrderType.TIME, credential=cred,
            )
        except Exception as e:
            items.append({"aid": aid, "bvid": bvid, "title": title, "error": f"取不到评论区：{e}"})
            continue
        for c in (sec.get("replies") or []):
            if not isinstance(c, dict):
                continue
            mem = c.get("member") or {}
            ct = int(c.get("ctime") or 0)
            items.append({
                # ⭐ rpid/root/aid 一律字符串（64 位大数，JS Number 会掉精度）
                "rpid": str(c.get("rpid") or ""),
                "root": str(c.get("root") or 0),
                "parent": str(c.get("parent") or 0),
                "aid": aid,
                "bvid": bvid,
                "title": title,
                "uid": str(mem.get("mid") or ""),
                "user": str(mem.get("uname") or ""),
                "said": str(((c.get("content") or {}).get("message")) or "")[:200],
                "like": int(c.get("like") or 0),
                "rcount": int(c.get("rcount") or 0),
                "is_me": str(mem.get("mid") or "") == str(me),
                "time": ct,
                "time_str": ts_to_day(ct),
                "days_ago": _days_ago(ct),
            })
    # 新的在前（ctime 降序）
    items.sort(key=lambda x: x.get("time") or 0, reverse=True)
    return json.dumps({
        "count": len(items),
        "items": items[: max(1, min(int(num or 10), 30))],
        "videos": [{"aid": str(v.get("aid") or ""), "bvid": str(v.get("bvid") or ""),
                    "title": str(v.get("title") or ""), "created": int(v.get("created") or 0)} for v in vlist],
        "hint": ("自己视频下还没有评论（正常结果）" if not items else
                 "⚠️ 回这些评论用 bili_reply(bvid, rpid, root, text)：楼中楼时 root 填楼主的 rpid，"
                 "一级评论不用填 root。is_me=true 的是自己发的楼，跳过"),
    }, ensure_ascii=False)


# ========== Tool: 判重账本状态（只读） ==========

@tool()
async def bili_guard_status(bvids: list = None, limit: int = 200) -> str:
    """
    看一眼**永久判重账本**（SQLite，重启不丢、跨进程共用）

    Args:
        bvids: 想核对的 BV 号列表（给了就只查这几条；不给就返回最近刷过的一批）
        limit: 最多返回几条（默认 200，上限 500）

    Returns:
        counts（seen / sent / pending / unknown 各多少）、seenVideos（已刷过的 BV）、
        activeReads（正在读的）、recentSends（最近发过什么 —— 只有键和元信息，**不含正文**）
    """
    guard = _get_runtime_guard()
    try:
        data = guard.snapshot(bvids=bvids, limit=limit)
    except Exception as e:
        return json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
    return json.dumps({"ok": True, **data}, ensure_ascii=False)


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")