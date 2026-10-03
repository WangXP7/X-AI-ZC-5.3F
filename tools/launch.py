# -*- coding: utf-8 -*-
"""tools/launch.py — 本机启动器（第 29 章 / 1.2.7）。

重复点击安全：文件锁串行；先复用健康实例（/­__xai_health 身份核对），否则启动新服务；
端口候选：显式 --port > .local/startup.json 已存端口 > 4183 > 4173 > 4184-4193。
健康检查通过后打开浏览器；--no-browser 只启动 / 检查。

说明：本实现以脱离终端的子进程启动（CREATE_NEW_PROCESS_GROUP + DETACHED_PROCESS），
并在启动后由 supervise.py 守护进程负责保活（第 41 章）。Windows CIM 独立启动为
后续增强项；当前守护已提供 30 秒原端口身份核验与自动重启。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
LOCK_FILE = LOCAL / "startup.lock"
STATE_FILE = LOCAL / "startup.json"
APP_NAME = "X-AI"
CANDIDATES_DEFAULT = [4183, 4173, 4184, 4185, 4186, 4187, 4188, 4189, 4190, 4191, 4192, 4193]


def no_proxy_opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


def health_ok(port: int) -> bool:
    try:
        with no_proxy_opener().open(f"http://127.0.0.1:{port}/__xai_health", timeout=3) as r:
            j = json.loads(r.read().decode("utf-8"))
            return j.get("app") == APP_NAME
    except Exception:
        return False


def read_saved_port():
    try:
        j = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        p = int(j.get("port") or 0)
        return p if 1024 < p < 65536 else None
    except Exception:
        return None


def save_state(port, pid):
    LOCAL.mkdir(exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "url": f"http://127.0.0.1:{port}/", "port": port, "pid": pid,
        "app": APP_NAME, "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def acquire_lock():
    LOCAL.mkdir(exist_ok=True)
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        return fd
    except FileExistsError:
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(0.4)
            if not LOCK_FILE.exists():
                try:
                    fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                    return fd
                except FileExistsError:
                    continue
        print("[launch] 另一个启动器正在处理，请稍后重试。")
        sys.exit(2)


def port_free(port: int) -> bool:
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def start_serve(port: int) -> int:
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        flags |= creation
    log = open(LOCAL / "static-server.log", "ab")
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "server.py"), "--port", str(port), "--quiet"],
        cwd=str(ROOT), stdout=log, stderr=log, creationflags=flags, close_fds=True)
    return proc.pid


def start_supervisor(port: int) -> None:
    # 守护（第 41 章）：30 秒核对原端口身份并重启本工程服务。前台快速返回。
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
    log = open(LOCAL / "supervisor.log", "ab")
    subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "supervise.py"), "--port", str(port)],
        cwd=str(ROOT), stdout=log, stderr=log, creationflags=flags, close_fds=True)


def main():
    ap = argparse.ArgumentParser(description="X-AI 本机启动器")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    fd = acquire_lock()
    try:
        candidates = []
        if args.port:
            candidates.append(args.port)
        saved = read_saved_port()
        if saved:
            candidates.append(saved)
        candidates += CANDIDATES_DEFAULT
        seen = set()
        candidates = [c for c in candidates if not (c in seen or seen.add(c))]

        # 1) 复用健康实例
        for p in candidates:
            if health_ok(p):
                save_state(p, 0)
                print(f"[launch] 复用已运行实例：http://127.0.0.1:{p}/")
                if not args.no_browser:
                    import webbrowser
                    webbrowser.open(f"http://127.0.0.1:{p}/")
                return
        # 2) 启动新实例
        chosen = None
        for p in candidates:
            if port_free(p):
                chosen = p
                break
        if chosen is None:
            print("[launch] 所有候选端口都被占用：请用 --port 指定一个空闲端口。")
            sys.exit(3)
        pid = start_serve(chosen)
        deadline = time.time() + 10
        while time.time() < deadline:
            if health_ok(chosen):
                save_state(chosen, pid)
                print(f"[launch] 服务已启动：http://127.0.0.1:{chosen}/（PID {pid}）")
                start_supervisor(chosen)
                if not args.no_browser:
                    import webbrowser
                    webbrowser.open(f"http://127.0.0.1:{chosen}/")
                return
            time.sleep(0.4)
        print(f"[launch] 启动失败：健康检查未通过。日志见 .local/static-server.log")
        sys.exit(4)
    finally:
        try:
            os.close(fd)
            LOCK_FILE.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
