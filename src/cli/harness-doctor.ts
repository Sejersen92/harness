// harness-doctor: is the Harness set up and healthy in this repository? One line per check, pass, warn
// or fail, with what it found. Records harness.doctor inside Claude Code. Exit 1 when anything fails,
// so a script (pu harness --install) can tell.
import { loadConfig, pluginRoot, projectDir } from "../lib/config.ts";
import { checks } from "../lib/setup.ts";
import { emitEvent } from "../lib/spool.ts";

const dir = projectDir();
const results = checks(dir, { pluginRoot: pluginRoot() });

process.stdout.write(`harness-doctor: ${dir}\n`);
for (const r of results) process.stdout.write(`  ${r.status.padEnd(5)} ${r.name.padEnd(16)} ${r.detail}\n`);
const count = (status: string): number => results.filter((r) => r.status === status).length;
process.stdout.write(`${count("pass")} pass, ${count("warn")} warn, ${count("fail")} fail\n`);

const config = loadConfig(dir);
if (config.mode !== "off" && process.env.CLAUDE_CODE_SESSION_ID) {
  const failures = Number.parseInt(results.find((r) => r.name === "emit-failures")?.detail ?? "", 10) || 0;
  emitEvent(config, "harness.doctor", {}, { checks: results.map(({ name, status }) => ({ name, status })), emit_failures: failures });
}
process.exit(count("fail") ? 1 : 0);
