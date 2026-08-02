"""LLM 决策后端：抽象调用协议 + pi RPC 长驻实现。

LLMStrategy 只依赖 LLMBackend 协议（ask -> str），不关心实现——
pi RPC 是默认后端，未来可直接换成 HTTP 后端（直连 NewAPI）而不动策略层。
"""

from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class ToolCall:
    """模型原生 tool_use 调用。"""
    name: str
    input: dict


@dataclass
class AskResult:
    """一次决策询问的结果：文本 + 工具调用（原生 tool calling）。"""
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)

    def tool(self, name: str) -> "ToolCall | None":
        for tc in self.tool_calls:
            if tc.name == name:
                return tc
        return None


class LLMBackend(Protocol):
    """LLM 决策调用协议（策略层依赖的唯一接口）。"""

    def ask(self, message: str, request_id: str, timeout: float) -> AskResult:
        """发送决策请求，返回决策结果。超时抛 TimeoutError。"""

    def close(self) -> None:
        """释放后端资源（进程/连接）。"""


def _extract_result(message: dict) -> AskResult:
    """从 turn_end.message 提取文本与 tool_use（Anthropic 风格 content blocks）。

    message 结构：{text: [blocks]} 或 {content: [blocks]}；
    block：{type:"text", text} / {type:"tool_use", name, input} / str。
    """
    blocks = message.get("text")
    if blocks is None:
        blocks = message.get("content")
    if not isinstance(blocks, list):
        return AskResult(text=str(blocks) if blocks is not None else "")
    texts, tools = [], []
    for block in blocks:
        if isinstance(block, str):
            texts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "text":
                texts.append(str(block.get("text", "")))
            elif block.get("type") == "tool_use":
                raw = block.get("input") or {}
                tools.append(ToolCall(
                    name=str(block.get("name", "")),
                    input=raw if isinstance(raw, dict) else {}))
    return AskResult(text="".join(texts), tool_calls=tools)


class PiRpcBackend(LLMBackend):
    """pi --mode rpc 长驻子进程（stdin/stdout JSONL 协议）。

    兼容原 pi 设计：--model 全称、--session-dir 落盘、会话历史前缀稳定
    → DeepSeek 服务端 context cache 命中（实测 94-98%）。
    跨平台 stdout 读取用后台线程 + 队列（Windows 无非阻塞管道）。
    """

    def __init__(self, pi_cli: Path, model: str, session_dir: Path,
                 startup_timeout: float = 30.0) -> None:
        self.cmd = ["node", str(pi_cli), "--mode", "rpc", "--model", model,
                    "--session-dir", str(session_dir)]
        self.proc = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", bufsize=1,
        )
        self.events: queue.Queue = queue.Queue()
        threading.Thread(target=self._read_loop, daemon=True).start()
        if not self.handshake(timeout=startup_timeout):
            raise RuntimeError(f"pi RPC 握手失败: {self._stderr_tail()}")

    def _read_loop(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.events.put(json.loads(line))
            except json.JSONDecodeError:
                pass  # 非 JSON 行（banner 等）跳过

    def _stderr_tail(self, limit: int = 2000) -> str:
        if self.proc.stderr is None:
            return ""
        try:
            return self.proc.stderr.read(limit)
        except Exception:
            return ""

    def _send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def _read_event(self, timeout: float) -> dict | None:
        try:
            return self.events.get(timeout=timeout)
        except queue.Empty:
            return None

    def handshake(self, timeout: float = 30.0) -> bool:
        """get_state 握手，确认 RPC 就绪。"""
        self._send({"id": "hs", "type": "get_state"})
        while True:
            ev = self._read_event(timeout)
            if ev is None:
                return False
            if ev.get("type") == "response" and ev.get("id") == "hs":
                return ev.get("success") is True

    def ask(self, message: str, request_id: str, timeout: float = 90.0) -> AskResult:
        """发 prompt，等 agent_settled，返回决策结果（文本 + 原生 tool_use）。"""
        self._send({"id": request_id, "type": "prompt", "message": message})
        last = AskResult(text="")
        while True:
            ev = self._read_event(timeout)
            if ev is None:
                raise TimeoutError(f"{request_id}: 等待事件超时")
            t = ev.get("type")
            if t == "turn_end":
                last = _extract_result(ev.get("message") or {})
            elif t == "agent_settled":
                return last

    def close(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
