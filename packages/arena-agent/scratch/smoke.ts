/* Scratch smoke: verify pi offline API behavior before writing the real factory. Deleted before commit. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  VERSION,
  defineTool,
} from "@earendil-works/pi-coding-agent";

const base = mkdtempSync(join(tmpdir(), "pi-smoke-"));
const cwd = join(base, "runtime");
const agentDir = join(base, "agent");
const { mkdirSync } = await import("node:fs");
mkdirSync(cwd, { recursive: true });
mkdirSync(agentDir, { recursive: true });

console.log("VERSION =", VERSION);

const arenaPlanTool = defineTool({
  name: "arena_plan",
  label: "Arena Plan",
  description: "dummy",
  parameters: { type: "object", properties: {}, additionalProperties: false } as never,
  execute: async () => ({ isError: false, content: [] }),
});
const arenaMapTool = defineTool({
  name: "arena_map",
  label: "Arena Map",
  description: "dummy",
  parameters: { type: "object", properties: {}, additionalProperties: false } as never,
  execute: async () => ({ isError: false, content: [] }),
});

try {
  const loader = new DefaultResourceLoader({ cwd, agentDir });
  await loader.reload();
  const sm = SessionManager.inMemory(cwd);
  const result = await createAgentSession({
    cwd,
    agentDir,
    noTools: "all",
    tools: ["arena_plan", "arena_map"],
    customTools: [arenaPlanTool, arenaMapTool],
    resourceLoader: loader,
    sessionManager: sm,
  });
  const s = result.session;
  console.log("session ok, instanceof AgentSession:", s instanceof AgentSession);
  console.log("fallbackMessage:", result.modelFallbackMessage ?? "(none)");
  console.log("arena_plan def:", s.getToolDefinition("arena_plan")?.name ?? "MISSING");
  console.log("arena_map def:", s.getToolDefinition("arena_map")?.name ?? "MISSING");
  console.log("read def:", s.getToolDefinition("read") ?? "undefined (good)");
  console.log("bash def:", s.getToolDefinition("bash") ?? "undefined (good)");
  console.log("active tools:", JSON.stringify(s.getActiveToolNames?.() ?? s.getActiveTools?.()));
} catch (err) {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
}
