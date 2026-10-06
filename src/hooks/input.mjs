import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The hook's JSON input from stdin; {} if it can't be read, so a hook never crashes on input. */
export async function readHookInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {};
  } catch {
    return {};
  }
}

/** Only subagents from this plugin are the Harness's business. */
export const isHarnessAgent = (input) => typeof input.agent_type === "string" && input.agent_type.startsWith("harness:");

/** Small per-agent state between SubagentStart and SubagentStop (start time), under <metadata dir>/state/agents. */
export const agentState = (config, agentId) => {
  const dir = join(config.metadataDir, "state", "agents");
  const file = join(dir, `${agentId}.json`);
  return {
    save(value) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify(value));
    },
    take() {
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      } finally {
        rmSync(file, { force: true });
      }
    },
  };
};
