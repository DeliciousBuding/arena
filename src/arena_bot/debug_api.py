"""本地调试/人工介入端点：http://127.0.0.1:8123（仅本机）。

- GET  /state      → 完整快照（单位/记忆/阶段/参数/暂停标志）
- GET  /strategies → 阶段与参数子集
- GET  /map/query?query=stats|obstacles|allies&bounds=x1,y1,x2,y2
                   → 共享地图只读查询（LLM arena_map 工具后端）
- POST /command    → {"cmd": ..., "args": {...}}，白名单指令

处理逻辑纯函数化（handle_request），可无端口单测；
服务器线程不阻塞主循环（ThreadingHTTPServer）。
"""

from __future__ import annotations

import json
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Callable

from .map_store import MapStore

# 白名单指令（main 注册命令处理器时校验）
COMMANDS = ("pause", "resume", "set_param", "set_phase", "shutdown")

SnapshotFn = Callable[[], dict]
CommandFn = Callable[[str, dict], tuple[bool, str]]


class DebugServer:
    """本地调试服务器。snapshot/command/map_store 由 main 注入。"""

    def __init__(self, host: str, port: int,
                 snapshot: SnapshotFn, command: CommandFn,
                 map_store: "MapStore | None" = None) -> None:
        self._snapshot = snapshot
        self._command = command
        self._map_store = map_store
        # bind 重试：Windows 上快速重启时旧进程端口处于 TIME_WAIT，
        # 直接 bind 报 WinError 10013——等待 TIME_WAIT（约 2 分钟）过期
        self._httpd = None
        for attempt in range(24):
            try:
                self._httpd = ThreadingHTTPServer((host, port), _make_handler(self))
                return
            except OSError as exc:
                if attempt == 23:
                    raise
                print(f"[debug] 端口 {port} bind 失败（{exc}），5s 后重试"
                      f"（等待 TIME_WAIT 过期，{attempt + 1}/24）", flush=True)
                time.sleep(5)

    def start(self) -> None:
        Thread(target=self._httpd.serve_forever, daemon=True, name="debug-api").start()

    def shutdown(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


def handle_request(method: str, path: str, body: bytes | None,
                   snapshot: SnapshotFn, command: CommandFn,
                   map_store: "MapStore | None" = None,
                   ) -> tuple[int, dict]:
    """纯函数路由：返回 (http_code, json_dict)。供测试直接调用。"""
    if method == "GET":
        if path == "/state":
            return 200, snapshot()
        if path == "/strategies":
            return 200, {"strategies": snapshot().get("strategies", {})}
        if path == "/map":
            return 200, {"map": snapshot().get("map", {})}
        if path.startswith("/map/query"):
            return _map_query(map_store, path)
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


def _map_query(map_store: "MapStore | None", path: str) -> tuple[int, dict]:
    """GET /map/query?query=kind&bounds=x1,y1,x2,y2 → 地图只读查询。"""
    if map_store is None:
        return 503, {"error": "map store 不可用"}
    parsed = urllib.parse.urlparse(path)
    params = urllib.parse.parse_qs(parsed.query)
    kind = params.get("query", [""])[0]
    if kind not in ("stats", "obstacles", "resources", "allies"):
        return 400, {"error": f"未知查询: {kind!r}"}
    bounds = None
    raw = params.get("bounds")
    if raw:
        try:
            nums = [int(v) for v in raw[0].split(",")]
        except ValueError:
            return 400, {"error": "bounds 需为 x1,y1,x2,y2 整数"}
        if len(nums) == 4:
            bounds = tuple(nums)
    return 200, {"query": kind, **map_store.query(kind, bounds=bounds)}


def _make_handler(server: DebugServer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args) -> None:  # 静默访问日志
            pass

        def _serve(self, method: str) -> None:
            length = int(self.headers.get("Content-Length", 0) or 0)
            body = self.rfile.read(length) if length else None
            code, obj = handle_request(method, self.path, body,
                                       server._snapshot, server._command,
                                       server._map_store)
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
