/** 契约产物生成：TypeBox wire schema → contracts/generated/*.schema.json。
 *
 * 运行（包目录内）：
 *   node scripts/generate-schemas.ts
 *
 * 产物入仓（契约固定，跨仓库消费：Python 校验 / 文档 / CI 对照）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AcceptedSchema,
  CommandPlanSchema,
  PlayerStateSchema,
  ReceivedSchema,
  StreamEnvelopeSchema,
  WorldObjectSchema,
  toJsonSchema,
} from "../src/wire-schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "contracts", "generated");
mkdirSync(outDir, { recursive: true });

const schemas = {
  "player-state.schema.json": PlayerStateSchema,
  "command-plan.schema.json": CommandPlanSchema,
  "accepted.schema.json": AcceptedSchema,
  "received.schema.json": ReceivedSchema,
  "stream-envelope.schema.json": StreamEnvelopeSchema,
  "world-object.schema.json": WorldObjectSchema,
};

for (const [name, schema] of Object.entries(schemas)) {
  const path = join(outDir, name);
  writeFileSync(path, toJsonSchema(schema) + "\n", "utf-8");
  console.log(`generated ${path}`);
}
