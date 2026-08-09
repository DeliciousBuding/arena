/**
 * Agent Registry（2026-08-09，agent-ecosystem-v1 §2.1）。
 *
 * key 分配 + 注册后台：SQLite data/runtime/registry.db（WAL，单一 writer =
 * registry API 端点）。生产 agent 登记官方 key 尾缀；模拟 agent 由本模块
 * 签发一次性明文模拟 key（simkey-<24 hex>），库存 SHA-256 哈希——明文只在
 * 注册/补发响应中出现一次，之后无法恢复（与 agents 台账的 api_key_tail /
 * key_hash 纪律一致：任何列表接口都不返回明文）。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT } from "./fs-jsonl.ts";

export type AgentMode = "production" | "simulation";

export const SIMKEY_PREFIX = "simkey-";
export const AGENT_MODES: readonly AgentMode[] = ["production", "simulation"];

export interface RegisterAgentInput {
  readonly username: string;
  readonly mode: AgentMode;
  /** production 模式必填：官方 key 的尾缀（仅登记尾缀，不存完整 key）。 */
  readonly apiKeyTail?: string;
}

export interface RegisteredAgent {
  readonly agentId: string;
  readonly username: string;
  readonly mode: AgentMode;
  readonly apiKeyTail: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  /** 仅 simulation：本次签发的一次性明文模拟 key（响应后无法再次获取）。 */
  readonly plaintextSimKey?: string;
}

export interface RegistryKey {
  readonly keyId: string;
  readonly agentId: string;
  readonly mode: AgentMode;
  readonly keyHash: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
}

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('production','simulation')),
  api_key_tail TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS keys (
  key_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('production','simulation')),
  key_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_keys_agent_id ON keys(agent_id);`;

/** 打开（必要时创建）registry 库。单一 writer = registry API。 */
export function openRegistryDb(): DatabaseSync {
  const dir = join(DATA_ROOT, "runtime");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "registry.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(REGISTRY_SCHEMA);
  return db;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 生成模拟 key：simkey- + 24 hex（12 随机字节）。 */
function generateSimKey(): string {
  return `${SIMKEY_PREFIX}${randomBytes(12).toString("hex")}`;
}

function isAgentMode(value: string): value is AgentMode {
  return value === "production" || value === "simulation";
}

/** 库值 → AgentMode（非法值回落 production，与 CHECK 约束对齐）。 */
function agentModeOf(value: unknown): AgentMode {
  const v = String(value);
  return isAgentMode(v) ? v : "production";
}

function rowToAgent(row: Record<string, unknown>): RegisteredAgent {
  return {
    agentId: String(row.agent_id),
    username: String(row.username),
    mode: agentModeOf(row.mode),
    apiKeyTail: row.api_key_tail === null ? null : String(row.api_key_tail),
    createdAt: String(row.created_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

function rowToKey(row: Record<string, unknown>): RegistryKey {
  return {
    keyId: String(row.key_id),
    agentId: String(row.agent_id),
    mode: agentModeOf(row.mode),
    keyHash: String(row.key_hash),
    issuedAt: String(row.issued_at),
    revokedAt: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

/**
 * 注册 agent。production 登记官方 key 尾缀（必填）；simulation 自动签发
 * 模拟 key 并返回明文（一次）。返回带明文 key 的 RegisteredAgent。
 */
export function registerAgent(db: DatabaseSync, input: RegisterAgentInput): RegisteredAgent {
  const username = input.username.trim();
  if (!username) throw new Error("username 不能为空");
  if (!isAgentMode(input.mode)) throw new Error("mode 必须是 production 或 simulation");
  const apiKeyTail = input.apiKeyTail?.trim() ?? "";
  if (input.mode === "production" && !apiKeyTail) {
    throw new Error("production 模式需要 api_key_tail");
  }

  const now = new Date().toISOString();
  const agentId = randomUUID();
  db.prepare(
    "INSERT INTO agents (agent_id, username, mode, api_key_tail, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(agentId, username, input.mode, input.mode === "production" ? apiKeyTail : null, now);

  // simulation：本次注册签发一次性明文模拟 key（响应后无法再次获取）
  const plaintextSimKey = input.mode === "simulation"
    ? issueSimKey(db, agentId, input.mode)
    : undefined;
  return {
    agentId,
    username,
    mode: input.mode,
    apiKeyTail: input.mode === "production" ? apiKeyTail : null,
    createdAt: now,
    revokedAt: null,
    ...(plaintextSimKey === undefined ? {} : { plaintextSimKey }),
  };
}

/** 补发模拟 key（仅 simulation 且未吊销的 agent），返回明文一次。 */
export function issueKey(db: DatabaseSync, agentId: string): RegisteredAgent | null {
  const rows = db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(agentId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const agent = rowToAgent(rows[0]!);
  if (agent.mode !== "simulation" || agent.revokedAt !== null) return null;
  const plaintextSimKey = issueSimKey(db, agentId, "simulation");
  return { ...agent, plaintextSimKey };
}

/** 签发一条模拟 key 记录（哈希入库），返回明文。 */
function issueSimKey(db: DatabaseSync, agentId: string, mode: AgentMode): string {
  const key = generateSimKey();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO keys (key_id, agent_id, mode, key_hash, issued_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(randomUUID(), agentId, mode, sha256Hex(key), now);
  return key;
}

/** 全部 agent 列表（含各自 key 记录，仅尾缀/哈希，无明文）。 */
export function listAgents(db: DatabaseSync): Array<RegisteredAgent & { keys: RegistryKey[] }> {
  const agents = db.prepare("SELECT * FROM agents ORDER BY created_at ASC").all() as Array<Record<string, unknown>>;
  const keysByAgent = new Map<string, RegistryKey[]>();
  for (const row of db.prepare("SELECT * FROM keys ORDER BY issued_at ASC").all() as Array<Record<string, unknown>>) {
    const key = rowToKey(row);
    const list = keysByAgent.get(key.agentId) ?? [];
    list.push(key);
    keysByAgent.set(key.agentId, list);
  }
  return agents.map((row) => ({ ...rowToAgent(row), keys: keysByAgent.get(String(row.agent_id)) ?? [] }));
}

/** 吊销 agent：置 revoked_at（agents + 其全部未吊销 key）。 */
export function revokeAgent(db: DatabaseSync, agentId: string): RegisteredAgent | null {
  const rows = db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(agentId) as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE agents SET revoked_at = ? WHERE agent_id = ?").run(now, agentId);
  db.prepare("UPDATE keys SET revoked_at = ? WHERE agent_id = ? AND revoked_at IS NULL").run(now, agentId);
  const updated = db.prepare("SELECT * FROM agents WHERE agent_id = ?").all(agentId) as Array<Record<string, unknown>>;
  return rowToAgent(updated[0]!);
}

/**
 * 校验模拟 key（常量时间比较）：返回对应 agent_id，无效返回 null。
 * 先按哈希定位候选（库内唯一），再用 timingSafeEqual 比对防时序侧信道。
 */
export function verifySimKey(db: DatabaseSync, key: string): string | null {
  if (!key.startsWith(SIMKEY_PREFIX)) return null;
  const hash = sha256Hex(key);
  const expected = Buffer.from(hash, "hex");
  const candidates = db.prepare(
    "SELECT key_hash FROM keys WHERE mode = 'simulation' AND revoked_at IS NULL",
  ).all() as Array<{ key_hash: string }>;
  for (const candidate of candidates) {
    const actual = Buffer.from(String(candidate.key_hash), "hex");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      const rows = db.prepare(
        "SELECT agent_id FROM keys WHERE key_hash = ? AND mode = 'simulation' AND revoked_at IS NULL",
      ).all(hash) as Array<{ agent_id: string }>;
      return rows.length > 0 ? String(rows[0]!.agent_id) : null;
    }
  }
  return null;
}
