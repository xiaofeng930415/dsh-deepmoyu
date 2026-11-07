#!/usr/bin/env python3
"""推送 B站引流台账 payload 到生产入库端点（规格 docs/spec-bili-ledger.md §4.1；实施票 #1146）。

形态照抄 scripts/register-links-to-server.py 已确立的通道：

    本地 push.py
      → ssh -T -i ~/.ssh/xianyu-kzf2_ed25519 root@47.115.213.159 <REMOTE_PYTHON>
          （整份 JSON 走 SSH stdin，不进远端 shell 语法或进程参数）
      → 远端 python 读 /etc/xianyu-links/xianyu-links.env 的 ADMIN_TOKEN
      → POST http://127.0.0.1:8765/api/admin/bili/ingest   (header: X-Admin-Token)
      → 响应逐字段回读验证（每个数组的 upserted 必须等于发出去的行数）

**token 不出服务器**：本地既不接触也不落盘任何凭据；失败信息里不回显 SSH stderr，
避免把服务器细节（乃至误配的 token）带进本地日志。

用法：
    python3 tools/bili-promotion/push.py --payload payload.json
    python3 tools/bili-promotion/push.py < payload.json
    python3 tools/bili-promotion/push.py --payload payload.json --dry-run

被 collect.py / up_baseline.py / backfill.py 复用时调 `push(payload, ...)`（同目录 `import push`）。
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

DEFAULT_HOST = "root@47.115.213.159"
DEFAULT_KEY = Path.home() / ".ssh/xianyu-kzf2_ed25519"
HOST_PATTERN = re.compile(r"[a-z_][a-z0-9_.-]*@[a-z0-9._-]+", re.IGNORECASE)

INGEST_URL = "http://127.0.0.1:8765/api/admin/bili/ingest"
INGEST_KEYS = ("comments", "videoSnapshots", "commentSnapshots", "upSnapshots")

# 远端命令是常量。payload 走 SSH stdin，不进远端 shell 语法；token 只在服务器进程内出现。
# 回读验证口径：端点返回的 upserted 是「本次处理的行数」（幂等重推不归零），
# 因此每个数组的 upserted 必须**等于发出去的行数**——对不上说明服务端没接全。
REMOTE_PYTHON = r'''
import json
import shlex
import sys
import urllib.error
import urllib.request
from pathlib import Path

KEYS = ("comments", "videoSnapshots", "commentSnapshots", "upSnapshots")

def read_admin_token():
    for line in Path("/etc/xianyu-links/xianyu-links.env").read_text(encoding="utf-8").splitlines():
        if line.startswith("ADMIN_TOKEN="):
            values = shlex.split(line.partition("=")[2].strip())
            if len(values) == 1 and values[0]:
                return values[0]
    raise ValueError("server-token-missing")

try:
    token = read_admin_token()
except Exception:
    print('{"ok":false,"error":"server-token-missing"}')
    sys.exit(1)

try:
    payload = json.load(sys.stdin)
except Exception:
    print('{"ok":false,"error":"invalid-payload-json"}')
    sys.exit(1)
if not isinstance(payload, dict):
    print('{"ok":false,"error":"invalid-payload-shape"}')
    sys.exit(1)

try:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:8765/api/admin/bili/ingest", data=body, method="POST",
        headers={"Content-Type": "application/json", "X-Admin-Token": token},
    )
    # 回环地址不走代理：urllib 默认会读 http_proxy / 系统代理（macOS 经 SystemConfiguration），
    # 一旦命中，POST 会被代理拦下并回一个与业务无关的 405/502，排查时极易跑偏。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=30) as response:
        result = json.load(response)
except urllib.error.HTTPError as error:
    print(json.dumps({"ok": False, "status": error.code}))
    sys.exit(1)
except Exception:
    print('{"ok":false,"error":"transport-or-response-failed"}')
    sys.exit(1)

data = result.get("data") if isinstance(result, dict) else None
verified = (result.get("ok") is True and isinstance(data, dict)
            and all(isinstance(data.get(key), dict)
                    and data[key].get("upserted") == len(payload.get(key) or [])
                    for key in KEYS))
print(json.dumps({
    "ok": verified,
    "error": None if verified else "response-mismatch",
    "counts": {key: (data or {}).get(key, {}).get("upserted") for key in KEYS},
}))
'''
REMOTE_COMMAND = "exec python3 -c " + shlex.quote(REMOTE_PYTHON)


class PushError(Exception):
    pass


def prepare_payload(document):
    """结构校验并归一 payload（四类数组各自可空）。

    只做**结构**校验：根对象、键名白名单、四个数组、每行是对象。
    枚举（source / visibility）与必填字段的判定权**只在服务端**（server/routes/admin.js
    → server/db.js），本脚本不复制第二份枚举——服务端 400 的 `invalid-*` 会带着明确
    错误码回到这里，比本地复制一份更容易保持一致。

    键名白名单是刻意的严格：把 `videoSnapshots` 拼成单数会被服务端静默忽略、
    整批数据无声丢弃；这里直接报错，代价是端点将来新增数组时要同步这一行。
    """
    if not isinstance(document, dict):
        raise PushError("payload 根节点必须是 JSON 对象")
    unknown = sorted(set(document) - set(INGEST_KEYS))
    if unknown:
        raise PushError(f"payload 含未知键：{', '.join(unknown)}（仅支持 {', '.join(INGEST_KEYS)}）")
    payload = {}
    for key in INGEST_KEYS:
        rows = document.get(key)
        if rows is None:
            payload[key] = []
            continue
        if not isinstance(rows, list):
            raise PushError(f"{key} 必须是数组")
        for index, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                raise PushError(f"{key} 第 {index} 行不是对象")
        payload[key] = rows
    return payload


def has_rows(payload):
    return any(payload.get(key) for key in INGEST_KEYS)


def build_remote_command():
    return REMOTE_COMMAND


def push(payload, host=DEFAULT_HOST, ssh_key=DEFAULT_KEY, *, run=subprocess.run, timeout=60):
    """经 SSH 把 payload 推到生产端点；成功返回服务端回读结果（含各表计数）。

    失败一律抛 PushError，且**不回显 stderr**（可能含服务器细节）。
    """
    message = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    command = ["ssh", "-T", "-i", str(ssh_key), "-o", "BatchMode=yes",
               "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
               host, REMOTE_COMMAND]
    try:
        result = run(command, input=message, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PushError("SSH 连接或服务器响应失败（详情不显示，以保护凭据）") from error
    try:
        response = json.loads(result.stdout)
    except (UnicodeError, json.JSONDecodeError, TypeError) as error:
        raise PushError("服务器返回无法验证的结果") from error
    if not isinstance(response, dict) or response.get("ok") is not True:
        status = response.get("status") if isinstance(response, dict) else None
        code = response.get("error") if isinstance(response, dict) else None
        if isinstance(status, int):
            raise PushError(f"服务器拒绝入库（HTTP {status}）")
        raise PushError(f"服务器未确认入库成功（{code or 'unknown'}）")
    return response


def format_counts(counts):
    if not isinstance(counts, dict):
        return ""
    return " ".join(f"{key}={counts.get(key)}" for key in INGEST_KEYS)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", help="payload JSON 文件路径；缺省或 `-` 表示从 stdin 读")
    parser.add_argument("--dry-run", action="store_true",
                        help="只校验并打印将要发送的 payload 与远端命令，不连接服务器")
    args = parser.parse_args(argv)

    try:
        if args.payload and args.payload != "-":
            try:
                document = json.loads(Path(args.payload).read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError) as error:
                raise PushError("无法读取合法的 payload JSON") from error
        else:
            try:
                document = json.loads(sys.stdin.read())
            except (UnicodeError, json.JSONDecodeError) as error:
                raise PushError("无法读取合法的 payload JSON（stdin）") from error
        payload = prepare_payload(document)
        if not has_rows(payload):
            raise PushError("payload 四类数组全为空，没有可推送的数据；未发送任何请求")

        counts = {key: len(payload[key]) for key in INGEST_KEYS}
        # 先把生效的 host / key 解出来（含 ECS_HOST / SSH_KEY 覆盖），dry-run 打印的就是真会用的那个；
        # 但**校验**只在真推时做，这样没配私钥的机器也能跑 dry-run 看 payload。
        host = os.environ.get("ECS_HOST", DEFAULT_HOST)
        key = Path(os.environ.get("SSH_KEY", str(DEFAULT_KEY))).expanduser()
        if args.dry_run:
            print("dry-run：校验通过，未连接服务器")
            print(f"将发送行数：{format_counts(counts)}")
            print(f"远端目标：{host}（私钥 {key}）")
            print("远端命令：ssh -T -i <key> -o BatchMode=yes -o ConnectTimeout=10 "
                  "-o StrictHostKeyChecking=yes <host> <REMOTE_PYTHON>（payload 走 stdin）")
            print("payload：")
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0

        if not HOST_PATTERN.fullmatch(host) or not key.is_file():
            raise PushError("SSH 主机名或私钥路径无效")

        response = push(payload, host=host, ssh_key=key)
        print(f"已入库：{format_counts(response.get('counts'))}")
        return 0
    except PushError as error:
        print(f"推送失败：{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
