# -*- coding: utf-8 -*-
"""tools/media_session.py — 本机媒体通道的短期会话凭证（第 40.3 章）。

内存中的随机签名密钥；服务重启即失效。凭证 = base64(origin|expires|nonce).hmac。
只签发给出自允许 Origin 的握手请求；不返回工作区路径、PID、密钥或用户文件。
"""
import base64
import hashlib
import hmac
import json
import secrets
import time

_KEY = secrets.token_bytes(32)
SESSION_TTL = 15 * 60  # 15 分钟

ALLOWED_ORIGINS = set()
MEDIA_HOSTS = {"cos-platform-outputs.agnes-ai.cn"}


def configure(page_origins, media_hosts=None):
    global ALLOWED_ORIGINS, MEDIA_HOSTS
    ALLOWED_ORIGINS = set(page_origins or [])
    if media_hosts:
        MEDIA_HOSTS = set(media_hosts)


def _sign(data: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(_KEY, data, hashlib.sha256).digest()).decode().rstrip("=")


def issue_session(origin: str):
    if origin not in ALLOWED_ORIGINS:
        return None
    expires = int(time.time()) + SESSION_TTL
    nonce = secrets.token_urlsafe(8)
    payload = json.dumps({"origin": origin, "expires": expires, "nonce": nonce}, separators=(",", ":"))
    body = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return {
        "protocol": "x-ai-media-v1",
        "token": f"{body}.{_sign(body.encode())}",
        "expiresInSeconds": SESSION_TTL,
    }


def verify_session(token: str, origin: str) -> bool:
    try:
        body, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(_sign(body.encode()), sig):
            return False
        pad = "=" * (-len(body) % 4)
        payload = json.loads(base64.urlsafe_b64decode(body + pad))
        if payload.get("expires", 0) < time.time():
            return False
        if payload.get("origin") != origin:
            return False
        return True
    except Exception:
        return False


def media_url_allowed(url: str) -> bool:
    """固定 Agnes 输出 CDN 的 HTTPS /videos/*.mp4，无内嵌凭据（第 40.4 章）。"""
    try:
        from urllib.parse import urlparse
        u = urlparse(url)
        if u.scheme != "https" or u.port not in (None, 443):
            return False
        if u.username or u.password:
            return False
        if u.hostname not in MEDIA_HOSTS:
            return False
        parts = u.path.split("/")
        if "videos" not in parts or not parts[-1].lower().endswith(".mp4"):
            return False
        return True
    except Exception:
        return False
