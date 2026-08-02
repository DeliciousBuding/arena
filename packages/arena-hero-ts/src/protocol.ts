/** Wire parsing and stable serialization for the public v0.1 protocol.
 *
 * W1 重构：字段级校验由 TypeBox wire schema 承担（wire-schema.ts 单源），
 * cross-field 关系约束由 types.ts 的 domain 校验承担。encodePlan 与上游
 * 逐字节兼容：sort_keys + exclude_none + 紧凑 JSON。
 */

import { Compile } from "typebox/compile";
import type { Accepted, CommandPlan } from "./actions.ts";
import { APIError, ProtocolError } from "./errors.ts";
import {
  checkPlayerStateRelations,
  checkReceivedConsistency,
  type PlayerState,
  type Received,
  type Tick,
} from "./types.ts";
import {
  AcceptedSchema,
  ReceivedSchema,
  StreamEnvelopeSchema,
} from "./wire-schema.ts";

const streamValidator = Compile(StreamEnvelopeSchema);
const acceptedValidator = Compile(AcceptedSchema);
const receivedValidator = Compile(ReceivedSchema);

function check(value: unknown, validator: ReturnType<typeof Compile>, message: string): void {
  if (!validator.Check(value)) {
    const first = [...validator.Errors(value)][0];
    throw new ProtocolError(`${message}${first ? `: ${first.message}` : ""}`);
  }
}

/** Parse one server WebSocket text message. */
export function parseStreamMessage(raw: string | Uint8Array): Tick | PlayerState | Received {
  if (raw instanceof Uint8Array) {
    throw new ProtocolError("the server sent a binary WebSocket message");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid Arena Hero WebSocket message");
  }
  check(parsed, streamValidator, "invalid Arena Hero WebSocket message");
  const envelope = parsed as { type: "tick" | "state" | "received"; data: unknown };
  if (envelope.type === "tick") {
    return { tick: envelope.data as number } satisfies Tick;
  }
  if (envelope.type === "state") {
    const state = envelope.data as PlayerState;
    checkPlayerStateRelations(state); // domain 关系约束
    return state;
  }
  // received：data 内含 plan，用独立 schema 校验
  check(envelope.data, receivedValidator, "invalid received message");
  const rec = envelope.data as Received;
  checkReceivedConsistency(rec);
  return rec;
}

/** 递归归一化：删 null/undefined 字段、对象键排序——对应上游 sort_keys + exclude_none。 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => [k, normalize(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** Serialize a complete plan into stable, compact UTF-8 JSON string. */
export function encodePlan(plan: CommandPlan): string {
  const data = normalize(plan);
  return JSON.stringify(data);
}

/** Parse a successful command acknowledgement. */
export function parseAccepted(raw: Uint8Array): Accepted {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new ProtocolError("invalid command acknowledgement");
  }
  check(parsed, acceptedValidator, "invalid command acknowledgement");
  return parsed as Accepted;
}

/** Build a structured API error without exposing request credentials. */
export function apiError(statusCode: number, raw: Uint8Array): APIError {
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    payload = {};
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    payload = {};
  }
  const p = payload as Record<string, unknown>;
  const error = typeof p.error === "string" ? p.error : "HTTP_ERROR";
  const message = typeof p.message === "string" ? p.message : null;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) {
    if (key !== "error" && key !== "message") {
      details[key] = value;
    }
  }
  return new APIError(statusCode, error, message, details);
}
