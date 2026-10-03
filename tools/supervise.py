# -*- coding: utf-8 -*-
"""tools/supervise.py — 本机服务守护（第 41.3 章）。

每 30 秒核对原端口的应用身份；无响应且端口空闲才重启本工程服务；
端口被其它程序占用时保留等待，不杀占用者、不换端口。
--stop 写入停止标志：守护停止自身，保留运行中的服务。
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
SUPERVISOR_LOCK = LOCAL / "supervisor.lock"
SUPERVISOR_STATE = LOCAL / "supervisor.json"
STOP_FLAG = LOCAL / "supervisor.stop"
APP_NAME = "X-AI"


def health_ok(port):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/__xai_health", timeout=3) as r:
            return json.loads(r.read().decode()).get("app") == APP_NAME
    except Exception:
        return False


def port_free(port):
    import socket
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def acquire():
    LOCAL.mkdir(exist_ok=True)
    try:
        fd = os.open(SUPERVISOR_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        return fd
    except FileExistsError:
        print("[supervise] 本工作区已有守护在运行。")
        sys.exit(0)


def save_state(port, pid, restarts):
    tmp = SUPERVISOR_STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps({
        "app": APP_NAME, "port": port, "pid": pid, "restarts": restarts,
        "heartbeat": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    os.replace(tmp, SUPERVISOR_STATE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--stop", action="store_true", help="停止守护（保留运行中的服务）")
    args = ap.parse_args()

    if args.stop:
        STOP_FLAG.parent.mkdir(exist_ok=True)
        STOP_FLAG.write_text("stop", encoding="utf-8")
        print("[supervise] 已写入停止标志；守护将退出，服务保留。")
        return

    fd = acquire()
    restarts = 0
    try:
        STOP_FLAG.unlink(missing_ok=True)
        print(f"[supervise] 守护启动：监控端口 {args.port}")
        while True:
            if STOP_FLAG.exists():
                print("[supervise] 收到停止标志，守护退出（服务保留）。")
                return
            if health_ok(args.port):
                save_state(args.port, 0, restarts)
            else:
                print(f"[supervise] 端口 {args.port} 无健康响应")
                if port_free(args.port):
                    restarts += 1
                    flags = 0
                    if os.name == "nt":
                        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    log = open(LOCAL / "static-server.log", "ab")
                    proc = subprocess.Popen(
                        [sys.executable, str(ROOT / "tools" / "server.py"), "--port", str(args.port), "--quiet"],
                        cwd=str(ROOT), stdout=log, stderr=log, creationflags=flags, close_fds=True)
                    save_state(args.port, proc.pid, restarts)
                    print(f"[supervise] 已重启服务（第 {restarts} 次，PID {proc.pid}）")
                    time.sleep(5)
                else:
                    print(f"[supervise] 端口 {args.port} 被其它程序占用：保留等待，不抢占")
            time.sleep(30)
    finally:
        try:
            os.close(fd)
            SUPERVISOR_LOCK.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
