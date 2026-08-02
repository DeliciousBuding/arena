"""LLM 决策后端：抽象调用协议 + pi RPC 长驻实现。

LLMStrategy 只依赖 LLMBackend 协议（ask -> str），不关心实现——
pi RPC 是默认后端，未来可直接换成 HTTP 后端（直连 NewAPI）而不动策略层。
"""

from __future__ import annotations

import json
import logging
import os
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol


@dataclass
class ToolCall:
    """模型原生 tool_use 调用。call_id 用于跨事件去重（turn_end 与
    tool_execution_start 可能重复报告同一调用）。"""
    name: str
    input: dict
    call_id: str = ""


@dataclass
class AskResult:
    """一次决策询问的结果：文本 + 思考 + 工具调用（原生 tool calling）。"""
    text: str
    thinking: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)

    def tool(self, name: str) -> "ToolCall | None":
        for tc in self.tool_calls:
            if tc.name == name:
                return tc
        return None

    def merge_tool_calls(self, calls: list["ToolCall"]) -> None:
        """合并工具调用（增量累积，按 call_id 去重）——turn_end 与
        tool_execution_start 报告同一调用时不重复。"""
        for tc in calls:
            if any(existing.call_id == tc.call_id for existing in self.tool_calls):
                continue
            self.tool_calls.append(tc)


class LLMBackend(Protocol):
    """LLM 决策调用协议（策略层依赖的唯一接口）。"""

    def ask(self, message: str, request_id: str, timeout: float) -> AskResult:
        """发送决策请求，返回决策结果。超时抛 TimeoutError。"""

    def close(self) -> None:
        """释放后端资源（进程/连接）。"""


def _extract_result(message: dict) -> AskResult:
    """从 turn_end.message 提取文本/思考/工具调用。

    message 结构：{role, content: [blocks]}；
    block：{type:"text", text} / {type:"thinking", thinking} /
           {type:"toolCall", name, arguments}（pi 原生命名，Anthropic 风格为
           tool_use + input，两者都认） / str。
    """
    blocks = message.get("text")
    if blocks is None:
        blocks = message.get("content")
    if not isinstance(blocks, list):
        return AskResult(text=str(blocks) if blocks is not None else "")
    texts, think, tools = [], [], []
    for block in blocks:
        if isinstance(block, str):
            texts.append(block)
        elif isinstance(block, dict):
            if block.get("type") == "text":
                texts.append(str(block.get("text", "")))
            elif block.get("type") == "thinking":
                think.append(str(block.get("thinking", "")))
            elif block.get("type") in ("toolCall", "tool_use"):
                raw = block.get("arguments")
                if not isinstance(raw, dict):
                    raw = block.get("input") or {}
                tools.append(ToolCall(
                    name=str(block.get("name", "")),
                    input=raw if isinstance(raw, dict) else {},
                    call_id=str(block.get("id", ""))))
    return AskResult(text="".join(texts), thinking="".join(think),
                     tool_calls=tools)


class PiRpcBackend(LLMBackend):
    """pi --mode rpc 长驻子进程（stdin/stdout JSONL 协议）。

    兼容原 pi 设计：--model 全称、--session-dir 落盘、会话历史前缀稳定
    → DeepSeek 服务端 context cache 命中（实测 94-98%）。
    跨平台 stdout 读取用后台线程 + 队列（Windows 无非阻塞管道）。
    """

    def __init__(self, pi_cli: Path, model: str, session_dir: Path,
                 startup_timeout: float = 30.0,
                 arena_extension: "Path | None" = None,
                 map_url: str | None = None) -> None:
        self.cmd = ["node", str(pi_cli), "--mode", "rpc", "--model", model,
                    "--session-dir", str(session_dir),
                    # 原生 extension 加载 pi-arena（工具白名单 + 禁内置）
                    "--no-builtin-tools",
                    "--tools", "arena_map,arena_plan"]
        if arena_extension is not None:
            self.cmd += ["--extension", str(arena_extension)]
        self._env = dict(os.environ)
        if map_url:
            self._env["ARENA_MAP_URL"] = map_url  # pi-arena extension 读此配置
        # 会话纪元：进程重启/超时隔离后 +1；策略层据此重发完整规则
        self.session_epoch = 0
        self._start_process()
        if not self.handshake(timeout=startup_timeout):
            raise RuntimeError(f"pi RPC 握手失败: {self._stderr_tail()}")

    def _start_process(self) -> None:
        """启动子进程 + 事件队列 + stdout/stderr 消费线程。"""
        self.proc = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8",
            errors="replace", bufsize=1, env=self._env,
        )
        self.events: queue.Queue = queue.Queue()
        threading.Thread(target=self._read_loop, daemon=True).start()
        # stderr 持续消费（防管道塞满卡死子进程），丢弃内容仅记尾段
        self._stderr_tail_buf: list[str] = []
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for line in self.proc.stderr:
            line = line.strip()
            if not line:
                continue
            self._stderr_tail_buf.append(line)
            if len(self._stderr_tail_buf) > 40:  # 只保留尾 40 行供诊断
                self._stderr_tail_buf.pop(0)

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
            return "".join(self._stderr_tail_buf)[-limit:]

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

    def _restart(self, reason: str) -> None:
        """进程重建（P0-2/P0-3）：超时隔离/崩溃自愈统一走这里。

        终止旧进程 → 清空事件队列（旧 tick 的迟到事件不会串到新会话）→
        新进程 + 握手 → session_epoch += 1（策略层据此重发完整规则）。
        """
        log = logging.getLogger("arena_bot.llm")
        log.warning("pi RPC 重建（%s），epoch %d → %d", reason,
                    self.session_epoch, self.session_epoch + 1)
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        self.session_epoch += 1
        self._start_process()
        if not self.handshake(timeout=30.0):
            raise RuntimeError("pi RPC 重建后握手失败")

    def _ensure_alive(self) -> None:
        """进程自愈：崩溃后自动重启 + 重新握手（长驻可靠性）。"""
        if self.proc.poll() is None:
            return
        self._restart(f"进程退出 rc={self.proc.returncode}")

    def ask(self, message: str, request_id: str, timeout: float = 90.0) -> AskResult:
        """发 prompt，等 agent_settled，返回决策结果。

        信息源：RPC 原生事件——
        - tool_execution_start：工具调用（含结构化 args，决策主输出）
        - turn_end：最终 assistant 消息（text/thinking，渲染用）

        timeout 是决策总预算：从发送到 agent_settled 的硬上限。
        超时即隔离：重启 RPC 进程 + 清空队列（迟到的旧 tick 事件无法串到
        下一 Tick）+ epoch+1（策略层重发规则），然后抛 TimeoutError。
        """
        self._ensure_alive()
        self._send({"id": request_id, "type": "prompt", "message": message})
        deadline = time.monotonic() + timeout
        last = AskResult(text="")
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._restart(f"{request_id} 决策总预算 {timeout:.0f}s 耗尽")
                raise TimeoutError(f"{request_id}: 决策总预算 {timeout:.0f}s 耗尽")
            ev = self._read_event(remaining)
            if ev is None:
                self._restart(f"{request_id} 等待事件超时")
                raise TimeoutError(f"{request_id}: 等待事件超时")
            t = ev.get("type")
            if t == "tool_execution_start":
                args = ev.get("args") or {}
                last.merge_tool_calls([ToolCall(
                    name=str(ev.get("toolName", "")),
                    input=args if isinstance(args, dict) else {},
                    call_id=str(ev.get("toolCallId", "")))])
            elif t == "turn_end":
                extracted = _extract_result(ev.get("message") or {})
                last.text = extracted.text
                last.thinking = extracted.thinking
                last.merge_tool_calls(extracted.tool_calls)
            elif t == "agent_settled":
                return last

    def close(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
