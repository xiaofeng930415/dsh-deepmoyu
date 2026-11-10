"""Offline regression for the defensive DM session buckets (2026-11-10, spec #1751 D / ticket #1759).

背景（为什么加这个测试）：
  收件箱原来只读 `session_type=1`。陌生人/未关注人的私信落在 2/8 桶（两套公开口径矛盾，
  没有一手实测），于是「回陌生人」在当前实现下**可能根本不可达** —— 而看了评论来私信的
  主要就是陌生人。

本文件钉住三件事（不联网、不碰凭证，全部用假 session 模块）：
  ① 读三个桶（1/2/8）合并去重，同一 talker 保留**最新** last_msg 的那个桶；
  ② **不读 5（被拦截）** —— 那个桶要本人在消息中心手动「信任」，是平台留的安全阀；
  ③ 单桶失败带回 `bucket_errors`，而不是静默少看一类人。

跑：python tests/test_dm_buckets.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "bilibili-mcp"

STRANGER = 123456789          # 没关注我们、我们也没关注的人
FOLLOWED = 987654321          # 互关的人
INTERCEPTED = 555555555       # 被平台拦截桶（type=5）里的账号 —— 绝不该被读到


def _session(talker, *, ts, sender=None, msg_type=1, unread=1, follow=False, text="在吗"):
    sender = talker if sender is None else sender
    return {
        "talker_id": talker,
        "session_type": 1,
        "unread_count": unread,
        "is_follow": follow,
        "last_msg": {
            "sender_uid": sender,
            "msg_type": msg_type,
            "msg_seqno": str(ts),
            "timestamp": ts,
            "content": json.dumps({"content": text}, ensure_ascii=False),
        },
    }


class _FakeSessionModule:
    """替身 bilibili_api.session：按 session_type 发不同的桶，可注入失败。"""

    def __init__(self, buckets, fail_types=()):
        self.buckets = buckets          # {session_type: [session, ...]}
        self.fail_types = set(fail_types)
        self.calls = []                 # 记录被请求过哪些桶

    async def get_sessions(self, credential=None, session_type=1):
        self.calls.append(session_type)
        if session_type in self.fail_types:
            raise RuntimeError(f"boom-{session_type}")
        return {"session_list": list(self.buckets.get(session_type, []))}


def _load_mcp(fake_session):
    """把 mcp_server 当模块加载，但把 bilibili_api.session 换成假模块、凭证换成假的。

    ⚠️ 直接 import mcp_server 会拉起 FastMCP + 一堆重依赖；这里只取我们要的两个纯函数
    （`_dm_collect_sessions` 与过滤逻辑所在的 `bili_dm_list` 实现），方式是把源码里
    相关段落摘出来 exec —— 保持与被测代码逐字一致（改了源码这里会跟着红）。
    """
    source = (VENDOR / "mcp_server.py").read_text(encoding="utf-8")
    # ⚠️ 从**定义处**取，不是从注释里的第一次出现取（注释里也提到 DM_SESSION_TYPES）
    start = source.index("\nDM_SESSION_TYPES = (") + 1
    end = source.index("# ========== Tool 21.2:")
    snippet = source[start:end]

    module = types.ModuleType("dm_buckets_under_test")
    module.__dict__["json"] = json
    module.__dict__["session"] = fake_session
    module.__dict__["cred"] = object()
    # `tool()` 装饰器替身：白名单语义不在这测（那是 selfcheck / tool-surface 的地盘），
    # 这里只要它把原函数原样还回来，好让 bili_dm_list 可被直接调用。
    def _tool_passthrough():
        def deco(fn):
            return fn
        return deco
    module.__dict__["tool"] = _tool_passthrough
    # get_cred / cred：凭证不在这测（不碰真凭证），给个假句柄
    module.__dict__["get_cred"] = lambda: object()
    module.__dict__["cred"] = None
    # _dm_nickname / _ts_to_str / _days_ago / _dm_text_of 都是纯辅助，给最小替身
    async def _nick(uid, cred):
        return f"nick-{uid}"
    module.__dict__["_dm_nickname"] = _nick
    module.__dict__["_ts_to_str"] = lambda ts: str(ts)
    module.__dict__["_days_ago"] = lambda ts: 0
    module.__dict__["_dm_text_of"] = lambda m: (m.get("content") or "")
    # stringify_ids 在 snippet 里不再被引用（合并路径不走它），给个恒等兜底
    module.__dict__["stringify_ids"] = lambda v: v
    exec(compile(snippet, str(VENDOR / "mcp_server.py"), "exec"), module.__dict__)
    return module


class DmBucketTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def _buckets(self):
        return {
            1: [_session(FOLLOWED, ts=1000, follow=True, text="老时间")],
            # 陌生人落在 2 桶；同一个人的更新一条落在 8 桶 ⇒ 合并后应保留 ts=3000 那条
            2: [_session(STRANGER, ts=2000, text="旧的一句")],
            8: [_session(STRANGER, ts=3000, text="新的一句")],
            # 被拦截桶（5）里有内容也不该被读到
            5: [_session(INTERCEPTED, ts=4000, text="被拦的")],
        }

    def test_three_buckets_merge_dedupe_and_keep_the_newest(self):
        fake = _FakeSessionModule(self._buckets())
        mod = _load_mcp(fake)
        sessions, errors = asyncio.run(mod._dm_collect_sessions())
        self.assertEqual(errors, [])
        uids = {s["talker_id"] for s in sessions}
        self.assertEqual(uids, {FOLLOWED, STRANGER})
        # 陌生人按 talker_id 去重后只留一条，且是时间戳更大的 8 桶那条
        stranger = [s for s in sessions if s["talker_id"] == STRANGER][0]
        self.assertEqual(stranger["last_msg"]["timestamp"], 3000)
        self.assertEqual(stranger["last_msg"]["content"], json.dumps({"content": "新的一句"}, ensure_ascii=False))
        # 三个桶都请求过
        self.assertEqual(sorted(fake.calls), [1, 2, 8])

    def test_intercepted_bucket_is_never_read(self):
        fake = _FakeSessionModule(self._buckets())
        mod = _load_mcp(fake)
        sessions, _ = asyncio.run(mod._dm_collect_sessions())
        self.assertNotIn(INTERCEPTED, {s["talker_id"] for s in sessions})
        self.assertNotIn(5, fake.calls)

    def test_one_bucket_failure_does_not_blind_the_rest(self):
        fake = _FakeSessionModule(self._buckets(), fail_types=(2,))
        mod = _load_mcp(fake)
        sessions, errors = asyncio.run(mod._dm_collect_sessions())
        # 2 桶挂了：那条旧消息看不到，但 8 桶的新消息还在（同一个人仍可达）
        self.assertEqual([e["session_type"] for e in errors], [2])
        self.assertIn("boom-2", errors[0]["error"])
        self.assertEqual({s["talker_id"] for s in sessions}, {FOLLOWED, STRANGER})
        stranger = [s for s in sessions if s["talker_id"] == STRANGER][0]
        self.assertEqual(stranger["last_msg"]["timestamp"], 3000)

    def test_bili_dm_list_payload_carries_bucket_errors_and_hint(self):
        fake = _FakeSessionModule(self._buckets(), fail_types=(8,))
        mod = _load_mcp(fake)
        payload = json.loads(asyncio.run(mod.bili_dm_list(num=10)))
        self.assertIn("bucket_errors", payload)
        self.assertEqual(payload["bucket_errors"][0]["session_type"], 8)
        self.assertIn("有会话桶读取失败", payload["hint"])
        # 挂掉一个桶不该让整个工具失败：剩下的会话照常返回
        # 8 桶挂 ⇒ 陌生人只剩 2 桶那条旧消息（ts=2000），仍然可回 —— 不会因为一个桶挂就被静默吞掉
        self.assertEqual(payload["count"], 2)
        self.assertEqual({item["uid"] for item in payload["items"]}, {str(FOLLOWED), str(STRANGER)})

    def test_empty_everything_is_a_normal_result(self):
        fake = _FakeSessionModule({})
        mod = _load_mcp(fake)
        payload = json.loads(asyncio.run(mod.bili_dm_list(num=10)))
        self.assertEqual(payload["count"], 0)
        self.assertEqual(payload["items"], [])
        self.assertNotIn("bucket_errors", payload)
        self.assertIn("正常结果", payload["hint"])

    def test_types_tuple_is_pinned_so_nobody_silently_drops_a_bucket(self):
        fake = _FakeSessionModule(self._buckets())
        mod = _load_mcp(fake)
        self.assertEqual(mod.DM_SESSION_TYPES, (1, 2, 8))
        self.assertNotIn(5, mod.DM_SESSION_TYPES)
        self.assertNotIn(4, mod.DM_SESSION_TYPES)


if __name__ == "__main__":
    unittest.main()
