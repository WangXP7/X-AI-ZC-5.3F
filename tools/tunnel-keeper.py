# -*- coding: utf-8 -*-
"""X-AI 隧道守护：保持公网隧道在线，断线自动重连（轮换 pinggy / serveo）。

把当前可用的公网 URL 写入 tunnel/CURRENT-URL.txt；每次重连 URL 会变化。
仅在本机使用；不影响 tools/publish-tunnel.cmd 的手动发布方式。
"""
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TUNNEL_DIR = ROOT / "tunnel"
URL_FILE = TUNNEL_DIR / "CURRENT-URL.txt"
LOG_FILE = TUNNEL_DIR / "keeper.log"

SSH_BASE = [
    "ssh", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=15",
]

PROVIDERS = [
    {
        "name": "pinggy",
        "argv": SSH_BASE + ["-p", "443", "-R0:127.0.0.1:8080", "free.pinggy.io"],
        "pattern": r"https://[a-z0-9-]+\.free\.pinggy\.net",
        "backoff": 60,
    },
    {
        "name": "serveo",
        "argv": SSH_BASE + ["-R", "80:127.0.0.1:8080", "serveo.net"],
        "pattern": r"https://[a-z0-9-]+\.serveousercontent\.com",
        "backoff": 25,
    },
    {
        "name": "localhost.run",
        "argv": SSH_BASE + ["-R", "80:127.0.0.1:8080", "nokey@localhost.run"],
        "pattern": r"https://[a-z0-9]+\.lhr\.life",
        "backoff": 30,
    },
]

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def log(msg):
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        print(line, flush=True)
    except Exception:
        pass
    try:
        with LOG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + chr(10))
    except Exception:
        pass  # 日志失败不能让守护退出


def write_url(url, provider):
    URL_FILE.parent.mkdir(exist_ok=True)
    URL_FILE.write_text(
        f"{url}\n（{provider} 隧道，更新时间 {time.strftime('%Y-%m-%d %H:%M:%S')}，已经过本网络可达性验证）\n"
        f"访问需授权密码：见 private/auth-password.txt\n",
        encoding="utf-8",
    )


def read_password():
    pw_file = ROOT / "private" / "auth-password.txt"
    try:
        return pw_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None


def verify_reachable(url):
    """本网络验证：登录页 200 + 密码表单；用授权密码登录后做 1MB 持续传输测试
    （截断大文件的服务商判失败）。"""
    password = read_password()
    if not password:
        log("  读取授权密码失败，跳过验证")
        return False
    for _ in range(2):
        try:
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
            req = urllib.request.Request(url.rstrip("/") + "/login",
                                         headers={"User-Agent": "xai-keeper/1.0"})
            with opener.open(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
                if not (resp.status == 200 and "授权密码" in body):
                    log(f"  可达性验证失败：HTTP {resp.status}")
                    return False
            data = urllib.parse.urlencode({"password": password}).encode()
            req1 = urllib.request.Request(url.rstrip("/") + "/login", data=data,
                                          headers={"User-Agent": "xai-keeper/1.0"})
            with opener.open(req1, timeout=15) as resp1:
                if resp1.status != 200:
                    log(f"  登录验证失败：HTTP {resp1.status}")
                    return False
            req2 = urllib.request.Request(url.rstrip("/") + "/healthz-big",
                                          headers={"User-Agent": "xai-keeper/1.0"})
            with opener.open(req2, timeout=30) as resp2:
                blob = resp2.read()
                if len(blob) != 1024 * 1024:
                    log(f"  大文件传输测试失败：仅收到 {len(blob)} 字节")
                    return False
            return True
        except Exception as e:
            log(f"  可达性验证异常：{type(e).__name__}")
            time.sleep(3)
    return False


def try_provider(p, attempt_log):
    """启动一个 ssh 并保持运行：提取 URL → 本网络验证可达。
    返回 (proc, url)：成功时 proc 仍运行（持有隧道）；失败时返回 (None, None)。"""
    attempt_log.write_bytes(b"")  # 清空上一轮日志，避免匹配到旧 URL
    proc = subprocess.Popen(p["argv"], stdout=attempt_log.open("wb"), stderr=subprocess.STDOUT)
    url = None
    deadline = time.time() + 25
    while time.time() < deadline and url is None:
        time.sleep(1.5)
        if proc.poll() is not None:
            return None, None  # ssh 提前退出
        try:
            text = ANSI_RE.sub("", attempt_log.read_bytes().decode("utf-8", "replace"))
        except OSError:
            continue
        m = re.search(p["pattern"], text)
        if m:
            url = m.group(0)
    if url is None:
        proc.terminate()
        return None, None
    if not verify_reachable(url):
        proc.terminate()
        return None, None
    return proc, url


def main():
    log("隧道守护启动；本地网关应为 http://127.0.0.1:8080")
    idx = 0
    attempt_log = TUNNEL_DIR / "last-attempt.log"
    while True:
        p = PROVIDERS[idx % len(PROVIDERS)]
        idx += 1
        log(f"尝试 {p['name']} …")
        url = None
        try:
            proc, url = try_provider(p, attempt_log)
        except Exception as e:
            log(f"{p['name']} 异常：{e}")
            proc = None
        if proc and url:
            write_url(url, p["name"])
            log(f"{p['name']} 隧道在线且可达：{url}")
            # 周期性复检：隧道建立后若网络环境变化导致不可达，主动重连
            rc = None
            fail_streak = 0
            while rc is None:
                try:
                    rc = proc.poll()
                except Exception:
                    rc = -1
                if rc is not None:
                    break
                time.sleep(120)
                if verify_reachable(url):
                    fail_streak = 0
                else:
                    fail_streak += 1
                    log(f"{p['name']} 复检失败（{fail_streak}/2）")
                    if fail_streak >= 2:
                        log(f"{p['name']} 连续不可达，主动重连")
                        proc.terminate()
                        rc = -2
            log(f"{p['name']} 隧道退出（rc={rc}），{p['backoff']} 秒后重连")
            time.sleep(p["backoff"])
        else:
            log(f"{p['name']} 未能建立或不可达（见 last-attempt.log），{p['backoff']} 秒后换下一个")
            time.sleep(p["backoff"])


if __name__ == "__main__":
    while True:
        try:
            main()
            break
        except KeyboardInterrupt:
            log("守护已停止")
            sys.exit(0)
        except SystemExit as e:
            if int(str(e) or 0) == 0:
                break
            log(f"守护以退出码 {e} 结束，10 秒后整体重启")
            time.sleep(10)
        except BaseException as e:
            log(f"守护异常：{type(e).__name__}: {e}；10 秒后整体重启")
            time.sleep(10)
