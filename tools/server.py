# -*- coding: utf-8 -*-
"""X-AI 授权密码网关服务。

只提供两件事：
1. 静态文件服务（app/ 目录，纯前端应用）。
2. 授权密码门：所有页面与资源必须先在 /login 输入授权密码，
   获得会话 Cookie 后才能访问。密码不写入前端代码。

仅使用 Python 标准库。默认只监听 127.0.0.1，公网访问
通过本机隧道（tools/publish-tunnel.cmd）转发，公网侧由隧道提供 HTTPS。
"""
import argparse
import html
import media_session
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import webbrowser
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = ROOT / "app"
DEFAULT_PASSWORD_FILE = ROOT / "private" / "auth-password.txt"

SESSION_COOKIE = "xai_session"
SESSION_TTL = 7 * 24 * 3600  # 7 天

LOGIN_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>X-AI · 授权访问</title>
<meta name="robots" content="noindex, nofollow">
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f6f3; color: #252633;
    font: 15px/1.65 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 380px; background: #fff; border: 1px solid #e3e1da;
    border-radius: 14px; padding: 30px 28px 26px;
    box-shadow: 0 8px 30px rgba(37, 38, 51, .07);
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
  .brand img { width: 44px; height: 44px; }
  .brand .name { font-size: 20px; font-weight: 650; letter-spacing: .3px; }
  .brand .sub { font-size: 11px; color: #656270; letter-spacing: 2.2px; }
  .hint { color: #656270; font-size: 14px; margin: 10px 0 18px; }
  label { display: block; font-size: 14px; margin-bottom: 6px; color: #44455a; }
  input[type=password] {
    width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid #cfcdc4;
    border-radius: 9px; background: #fff; color: #252633;
  }
  input[type=password]:focus { outline: 2px solid #6750cc33; border-color: #6750cc; }
  button {
    width: 100%; margin-top: 16px; padding: 11px 14px; font-size: 15px; font-weight: 600;
    color: #fff; background: #6750cc; border: 0; border-radius: 9px; cursor: pointer;
  }
  button:hover { background: #5742b3; }
  .error {
    display: none; margin-top: 14px; padding: 9px 12px; border-radius: 8px; font-size: 14px;
    color: #8f1d2c; background: #fbeaed; border: 1px solid #eec4ca;
  }
  .error.show { display: block; }
  .foot { margin-top: 18px; font-size: 12px; color: #656270; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <img src="/logo.svg" alt="X-AI">
      <div>
        <div class="name">X-AI</div>
        <div class="sub">VIDEO STUDIO</div>
      </div>
    </div>
    <p class="hint">此工作台需要授权密码才能访问。密码由发布者设置，输入后在本浏览器保持登录。</p>
    <form method="post" action="/login">
      <label for="pw">授权密码</label>
      <input type="password" id="pw" name="password" autocomplete="current-password" autofocus required>
      <button type="submit">进入工作台</button>
    </form>
    <div class="error" id="err">__ERROR__</div>
    <div class="foot">X-AI 1.0 · ® YiQiXP</div>
  </main>
</body>
</html>"""


class Gate:
    """会话与登录限速状态（进程内存内，重启后需重新登录）。"""

    def __init__(self, password: str):
        self.password = password
        self.sessions = {}  # token -> expires_at
        self.fail_times = []  # 失败时间戳（全局，简单限速）
        self.lock = threading.Lock()

    def check(self, token: str) -> bool:
        now = time.time()
        with self.lock:
            exp = self.sessions.get(token)
            if exp is None:
                return False
            if exp < now:
                del self.sessions[token]
                return False
            return True

    def login(self, password: str) -> str | None:
        now = time.time()
        with self.lock:
            recent = [t for t in self.fail_times if now - t < 300]
            self.fail_times = recent
            if len(recent) >= 10:
                return None  # 触发限速：5 分钟内已有 10 次失败
            if secrets.compare_digest(password.encode("utf-8"), self.password.encode("utf-8")):
                token = secrets.token_urlsafe(32)
                self.sessions[token] = now + SESSION_TTL
                self.fail_times = []
                return token
            self.fail_times.append(now)
            return None


class Handler(BaseHTTPRequestHandler):
    server_version = "X-AI-Gateway/1.0"
    root: Path = DEFAULT_ROOT
    gate: Gate = None
    verbose: bool = True

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        if self.verbose:
            sys.stderr.write("[server] %s - %s\n" % (self.address_string(), fmt % args))

    def _session_token(self):
        header = self.headers.get("Cookie", "")
        try:
            jar = cookies.SimpleCookie(header)
        except cookies.CookieError:
            return None
        morsel = jar.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def _authorized(self):
        token = self._session_token()
        return bool(token) and self.gate.check(token)

    def _send(self, code, body: bytes, ctype: str, extra=None, cache=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        if cache:
            self.send_header("Cache-Control", cache)
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _html(self, code, text, extra=None):
        self._send(code, text.encode("utf-8"), "text/html; charset=utf-8", extra, cache="no-store")

    def _redirect(self, location):
        self._send(302, b"", "text/plain; charset=utf-8", [("Location", location)], cache="no-store")

    # ---------- 路由 ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/login":
            if self._authorized():
                return self._redirect("/")
            page = LOGIN_PAGE.replace("__ERROR__", "")
            return self._html(200, page)

        if path == "/healthz":
            return self._send(200, b"ok", "text/plain; charset=utf-8", cache="no-store")

        if path == "/__xai_health":
            body = json.dumps({"app": "X-AI", "version": "1.2.7"}).encode("utf-8")
            return self._send(200, body, "application/json; charset=utf-8", cache="no-store")

        if path == "/__xai_media_session":
            return self._media_session_get()

        if path == "/__xai_media":
            return self._media_post()

        if not self._authorized():
            if path == "/logo.svg":
                # 登录页需要 logo；logo 不含任何秘密
                return self._serve_file("assets/logo.svg")
            wants_html = "text/html" in self.headers.get("Accept", "text/html")
            if wants_html:
                return self._redirect("/login")
            body = json.dumps({"error": "unauthorized"}).encode("utf-8")
            return self._send(401, body, "application/json; charset=utf-8", cache="no-store")

        if path == "/auth-state":
            # 告知前端：服务端密码门已生效，客户端密码门不必再次询问
            body = json.dumps({"serverGate": True}).encode("utf-8")
            return self._send(200, body, "application/json; charset=utf-8", cache="no-store")

        if path == "/healthz-big":
            # 1MB 持续传输测试（需登录）：隧道守护用它验证大文件不被截断
            body = b"\0" * (1024 * 1024)
            return self._send(200, body, "application/octet-stream", cache="no-store")

        if path == "/logout":
            token = self._session_token()
            if token:
                with self.gate.lock:
                    self.gate.sessions.pop(token, None)
            self._send(302, b"", "text/plain", [
                ("Location", "/login"),
                ("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"),
            ])
            return

        rel = path.lstrip("/") or "index.html"
        return self._serve_file(rel)

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/login":
            return self._send(404, b'{"error":"not found"}', "application/json", cache="no-store")

        length = min(int(self.headers.get("Content-Length") or 0), 4096)
        form = parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
        password = (form.get("password") or [""])[0]
        token = self.gate.login(password)
        if token is None:
            with self.gate.lock:
                limited = len([t for t in self.gate.fail_times if time.time() - t < 300]) >= 10
            msg = "尝试过于频繁，请稍后再试。" if limited else "授权密码不正确，请重试。"
            page = LOGIN_PAGE.replace("__ERROR__", html.escape(msg))
            return self._html(401, page)

        cookie = f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}"
        return self._send(302, b"", "text/plain", [("Location", "/"), ("Set-Cookie", cookie)])

    # ---------- 媒体中继（第 40 章） ----------
    def _media_cors(self, origin):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-XAI-Media-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Type", "application/json; charset=utf-8")

    def _media_session_get(self):
        origin = self.headers.get("Origin", "")
        if origin not in media_session.ALLOWED_ORIGINS:
            return self._send(403, b'{"error":"origin not allowed"}', "application/json; charset=utf-8", cache="no-store")
        sess = media_session.issue_session(origin)
        if not sess:
            return self._send(403, b'{"error":"origin not allowed"}', "application/json; charset=utf-8", cache="no-store")
        body = json.dumps(sess).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if origin in media_session.ALLOWED_ORIGINS and urlparse(self.path).path in ("/__xai_media", "/__xai_media_session"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-XAI-Media-Token")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(204, b"", "text/plain")

    def _media_post(self):
        origin = self.headers.get("Origin", "")
        token = self.headers.get("X-XAI-Media-Token", "")
        if origin not in media_session.ALLOWED_ORIGINS or not media_session.verify_session(token, origin):
            # 丢弃最多 8KB 请求体，避免 Windows 因未读字节把 403 变成连接重置（第 40.4 章）
            try:
                n = int(self.headers.get("Content-Length") or 0)
                while n > 0:
                    chunk = self.rfile.read(min(n, 8192))
                    if not chunk:
                        break
                    n -= len(chunk)
            except Exception:
                pass
            return self._send(403, b'{"error":"media_session_required"}', "application/json; charset=utf-8", cache="no-store")
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 8192)
            req = json.loads(self.rfile.read(length).decode("utf-8", "replace") or "{}")
            url = req.get("url", "")
        except Exception:
            return self._send(400, b'{"error":"bad request"}', "application/json; charset=utf-8")
        if not media_session.media_url_allowed(url):
            return self._send(400, b'{"error":"url not allowed"}', "application/json; charset=utf-8")
        try:
            import urllib.request
            up_req = urllib.request.Request(url, headers={"User-Agent": "X-AI-LocalMedia/1.2.7"})
            up = urllib.request.urlopen(up_req, timeout=180)
        except Exception as e:
            body = json.dumps({"error": "upstream_unavailable", "message": str(e)[:120]}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", origin)
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            total = int(up.headers.get("Content-Length") or 0)
            if total > 512 * 1024 * 1024:
                up.close()
                return self._send(413, b'{"error":"too large"}', "application/json; charset=utf-8")
            self.send_response(200)
            self.send_header("Content-Type", up.headers.get("Content-Type") or "application/octet-stream")
            self.send_header("Content-Length", str(total))
            self.send_header("Access-Control-Allow-Origin", origin)
            self.end_headers()
            remaining = total if total else 512 * 1024 * 1024
            while True:
                chunk = up.read(65536)
                if not chunk:
                    break
                remaining -= len(chunk)
                if total and remaining < 0:
                    up.close()
                    return
                self.wfile.write(chunk)
        finally:
            try:
                up.close()
            except Exception:
                pass

    # ---------- 静态文件 ----------
    def _serve_file(self, rel: str):
        root = self.root.resolve()
        target = (root / rel).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return self._send(403, b"forbidden", "text/plain; charset=utf-8")
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            return self._send(404, b"not found", "text/plain; charset=utf-8")

        ctype, _ = mimetypes.guess_type(str(target))
        ctype = ctype or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        suffix = target.suffix.lower()
        if suffix in (".html", ".json"):
            cache = "no-store"
        elif suffix in (".js", ".mjs", ".css", ".svg"):
            cache = "no-cache"  # 必须 revalidate，避免发布更新后浏览器仍用旧代码
        elif suffix == ".wasm":
            cache = "public, max-age=86400"
        else:
            cache = "public, max-age=300"

        extra = []
        data = target.read_bytes()

        # Range 请求（单区间）：供客户端对大文件做分块续传
        range_header = self.headers.get("Range")
        if range_header and suffix == ".wasm":
            m = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
            if m and (m.group(1) or m.group(2)):
                total = len(data)
                start = int(m.group(1)) if m.group(1) else max(0, total - int(m.group(2)))
                end = int(m.group(2)) if m.group(2) else total - 1
                end = min(end, total - 1)
                if start <= end and start < total:
                    chunk = data[start:end + 1]
                    self.send_response(206)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(chunk)))
                    self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                    self.send_header("Accept-Ranges", "bytes")
                    self.send_header("Cache-Control", cache)
                    for k, v in extra:
                        self.send_header(k, v)
                    self.end_headers()
                    if self.command != "HEAD":
                        self.wfile.write(chunk)
                    return

        # 大文件 gzip：wasm 等 32MB 级资源压缩约 3 倍，改善慢速隧道下的加载
        accepts_gzip = "gzip" in self.headers.get("Accept-Encoding", "")
        if accepts_gzip and suffix in (".wasm",) and len(data) > 1024 * 1024:
            gz = target.with_suffix(target.suffix + ".gz")
            try:
                if not gz.is_file() or gz.stat().st_mtime < target.stat().st_mtime:
                    import gzip as _gzip
                    gz.write_bytes(_gzip.compress(data, 6))
                data = gz.read_bytes()
                extra.append(("Content-Encoding", "gzip"))
                cache = "public, max-age=86400"
            except Exception:
                pass
        self._send(200, data, ctype, extra=extra, cache=cache)


def load_password(path: Path, quiet: bool = False) -> str:
    if path.is_file():
        pw = path.read_text(encoding="utf-8").strip()
        if pw:
            return pw
    pw = secrets.token_urlsafe(12)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(pw + "\n", encoding="utf-8")
    print(f"[server] 已生成新的授权密码，保存在：{path}")
    print(f"[server] 授权密码：{pw}")
    if not quiet:
        print("[server] 请把上面这行密码交给需要访问的人。")
    return pw


def main():
    ap = argparse.ArgumentParser(description="X-AI 授权密码网关")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    ap.add_argument("--password-file", default=str(DEFAULT_PASSWORD_FILE))
    ap.add_argument("--quiet", action="store_true", help="减少访问日志")
    ap.add_argument("--open", action="store_true", help="启动后打开浏览器")
    args = ap.parse_args()

    password = load_password(Path(args.password_file), quiet=args.quiet)
    Handler.root = Path(args.root).resolve()
    try:
        relay_cfg = json.loads((Handler.root / 'media-relay.json').read_text(encoding='utf-8'))
        media_session.configure(relay_cfg.get('pageOrigins'), relay_cfg.get('allowedMediaHosts'))
        print('[server] 媒体中继已启用：来源', relay_cfg.get('pageOrigins'))
    except Exception as e:
        print('[server] 媒体中继未启用：', e)
    Handler.gate = Gate(password)
    Handler.verbose = not args.quiet

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}/"
    print(f"[server] X-AI 网关已启动：{url}")
    print(f"[server] 授权密码：{password}")
    if args.open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 已停止。")


if __name__ == "__main__":
    main()
