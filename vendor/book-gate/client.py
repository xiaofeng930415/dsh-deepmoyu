#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""鲸鱼书源门 · 本机侧客户端。

形态照抄 `tools/bili-promotion/push.py` 已确立的通道（规格 §6.1）：

    本机 client.py
      → ssh -T -i <key> root@<host> "exec python3 -c <服务器脚本源码>"
          （请求 JSON 走 SSH stdin，不进远端 shell 语法；凭证只在服务器进程内出现）
      → 服务器固定脚本：读本地 env 的 BOOK_GATE_TOKEN → 台账/网盘/claim → 回传 JSON
      → 本机只拿到 {ok, found, block, ...}，**看不到链接文本**

用法：
    python3 tools/book-gate/client.py '{"title": "小岛经济学"}'
    echo '{"title": "小岛经济学"}' | python3 tools/book-gate/client.py

环境变量（可选）：BOOK_GATE_HOST（默认 root@47.115.213.159）、BOOK_GATE_SSH_KEY
（默认 ~/.ssh/xianyu-kzf2_ed25519）、BOOK_GATE_SERVER_SCRIPT（默认同目录 server.py）。
"""

import argparse
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

DEFAULT_HOST = os.environ.get("BOOK_GATE_HOST", "root@47.115.213.159")
DEFAULT_KEY = Path(os.environ.get("BOOK_GATE_SSH_KEY", str(Path.home() / ".ssh/xianyu-kzf2_ed25519")))
DEFAULT_SERVER = Path(__file__).resolve().parent / "server.py"
CONNECT_TIMEOUT = 10
TOTAL_TIMEOUT = 330


def build_remote_command(server_source):
    """服务器脚本作为 `python3 -c` 的常量参数；请求 JSON 只走 stdin。"""
    return "exec python3 -c " + shlex.quote(server_source)


def run_gate(request, *, host=DEFAULT_HOST, ssh_key=DEFAULT_KEY, server_script=DEFAULT_SERVER,
             timeout=TOTAL_TIMEOUT, run=subprocess.run):
    """请求 dict → 响应 dict（结构化失败，不抛异常）。`run` 可注入，测试用它替掉 SSH。"""
    if not isinstance(request, dict) or not str(request.get("title") or "").strip():
        return {"ok": False, "code": "gate-error", "detail": "title 不能为空"}
    try:
        source = Path(server_script).read_text(encoding="utf-8")
    except OSError as error:
        return {"ok": False, "code": "gate-error", "detail": "读不到服务器脚本：%s" % error}
    command = [
        "ssh", "-T", "-i", str(ssh_key),
        "-o", "BatchMode=yes", "-o", "ConnectTimeout=%d" % CONNECT_TIMEOUT,
        "-o", "StrictHostKeyChecking=yes",
        host, build_remote_command(source),
    ]
    message = json.dumps(request, ensure_ascii=False).encode("utf-8")
    try:
        result = run(command, input=message, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        return {"ok": False, "code": "gate-timeout", "detail": "SSH 调用超时"}
    except OSError as error:
        return {"ok": False, "code": "gate-error", "detail": "SSH 调用失败（详情不回显）"}
    try:
        response = json.loads(result.stdout.decode("utf-8") or "{}")
    except (UnicodeError, ValueError):
        return {"ok": False, "code": "gate-error", "detail": "服务器返回无法解析（exit %s）" % result.returncode}
    if not isinstance(response, dict):
        return {"ok": False, "code": "gate-error", "detail": "服务器返回形状非法"}
    return response


def main(argv=None):
    parser = argparse.ArgumentParser(description="鲸鱼书源门客户端（ssh → 服务器固定脚本）")
    parser.add_argument("request", nargs="?", help="请求 JSON；缺省或 `-` 表示从 stdin 读")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--ssh-key", default=str(DEFAULT_KEY))
    parser.add_argument("--server-script", default=str(DEFAULT_SERVER))
    parser.add_argument("--timeout", type=float, default=TOTAL_TIMEOUT)
    parser.add_argument("--dry-run", action="store_true", help="只打印远端命令长度，不发起 SSH")
    args = parser.parse_args(argv)

    raw = sys.stdin.read() if (not args.request or args.request == "-") else args.request
    try:
        request = json.loads(raw or "{}")
    except ValueError as error:
        print(json.dumps({"ok": False, "code": "gate-error", "detail": "请求不是合法 JSON：%s" % error},
                         ensure_ascii=False))
        return 0
    if args.dry_run:
        source = Path(args.server_script).read_text(encoding="utf-8")
        command = build_remote_command(source)
        print(json.dumps({"ok": True, "dryRun": True, "remoteCommandBytes": len(command),
                          "sourceBytes": len(source), "request": request}, ensure_ascii=False))
        return 0
    response = run_gate(request, host=args.host, ssh_key=args.ssh_key,
                        server_script=args.server_script, timeout=args.timeout)
    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
