"""本地调试/人工介入端点：http://127.0.0.1:8123（仅本机）。

- GET  /state      → 完整快照（单位/记忆/阶段/参数/暂停标志）
- GET  /strategies → 阶段与参数子集
- POST /command    → {"cmd": ..., "args": {...}}，白名单指令

处理逻辑纯函数化（handle_request），可无端口单测；
服务器线程不阻塞主循环（ThreadingHTTPServer）。
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Callable

# 白名单指令（main 注册命令处理器时校验）
COMMANDS = ("pause", "resume", "set_param", "set_phase")

SnapshotFn = Callable[[], dict]
CommandFn = Callable[[str, dict], tuple[bool, str]]


class DebugServer:
    """本地调试服务器。snapshot/command 由 main 注入。"""

    def __init__(self, host: str, port: int,
                 snapshot: SnapshotFn, command: CommandFn) -> None:
        self._snapshot = snapshot
        self._command = command
        self._httpd = ThreadingHTTPServer((host, port), _make_handler(self))

    def start(self) -> None:
        Thread(target=self._httpd.serve_forever, daemon=True, name="debug-api").start()

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


def handle_request(method: str, path: str, body: bytes | None,
                   snapshot: SnapshotFn, command: CommandFn,
                   ) -> tuple[int, dict]:
    """纯函数路由：返回 (http_code, json_dict)。供测试直接调用。"""
    if method == "GET":
        if path == "/state":
            return 200, snapshot()
        if path == "/strategies":
            return 200, {"strategies": snapshot().get("strategies", {})}
        if path == "/map":
            return 200, {"map": snapshot().get("map", {})}
        return 404, {"error": "not found"}
    if method == "POST":
        if path != "/command":
            return 404, {"error": "not found"}
        try:
            payload = json.loads(body or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            return 400, {"error": "bad json"}
        cmd = payload.get("cmd")
        args = payload.get("args") or {}
        if cmd not in COMMANDS or not isinstance(args, dict):
            return 400, {"error": f"invalid command: {cmd!r}"}
        ok, msg = command(cmd, args)
        return (200, {"ok": ok, "msg": msg}) if ok else (400, {"ok": False, "msg": msg})
    return 405, {"error": "method not allowed"}


def _make_handler(server: DebugServer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # 静默访问日志
            pass

        def _serve(self, method: str) -> None:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else None
            code, obj = handle_request(method, self.path, body,
                                       server._snapshot, server._command)
            data = json.dumps(obj, default=str).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self) -> None:
            self._serve("GET")

        def do_POST(self) -> None:
            self._serve("POST")

    return Handler
