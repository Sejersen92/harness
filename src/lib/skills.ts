// The skills an agent's definition preloads (its `skills:` frontmatter), as context a hook can inject.
//
// Claude Code preloads them into a subagent itself, but not into a main-thread `claude --agent` session, which
// is how the orchestrator runs (probed on 2.1.292, 2026-10-17: a subagent saw its skill, the main thread didn't,
// with or without the plugin prefix). The SessionStart hook fills that gap from the same `skills:` list, so the
// definition stays the one place an agent's skills are declared.
//
// A hook's additionalContext over 10,000 characters is cut to a preview, but the limit is per hook (probed the
// same day), so the skills are packed in order into up to SLOTS parts, one SessionStart hook per part.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SLOTS = 4;
/** Below the 10,000-character cut, with room for the part's header. */
export const SLOT_BUDGET = 9_500;

/**
 * A definition's frontmatter lines and its body. Not parsed as YAML: Claude Code reads agent frontmatter
 * leniently, and the descriptions hold unquoted colons a strict parser refuses.
 */
const frontmatter = (text: string): { head: string[]; body: string } => {
  const match = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  return match ? { head: (match[1] ?? "").split("\n"), body: match[2] ?? "" } : { head: [], body: text };
};

/** The agent's definition file for an agent type such as `harness:orchestrator`, or null for another plugin's. */
export const definitionPath = (pluginRoot: string, agentType: string): string | null =>
  agentType.startsWith("harness:") ? join(pluginRoot, "agents", `${agentType.slice("harness:".length)}.md`) : null;

/** The skills a definition's frontmatter lists, as written (`harness:complexity-rubric`). */
export function declaredSkills(definition: string): string[] {
  const { head } = frontmatter(definition);
  const start = head.findIndex((line) => /^skills:\s*$/.test(line));
  if (start < 0) return [];
  const skills: string[] = [];
  for (const line of head.slice(start + 1)) {
    const item = line.match(/^\s+-\s+(\S+)\s*$/);
    if (!item?.[1]) break;
    skills.push(item[1]);
  }
  return skills;
}

/** A plugin skill's file, or null when the name isn't one of this plugin's. */
export const skillPath = (pluginRoot: string, name: string): string | null =>
  name.startsWith("harness:") ? join(pluginRoot, "skills", name.slice("harness:".length), "SKILL.md") : null;

/** The injected section for one skill: its body under a heading that names it, without its frontmatter. */
export const skillSection = (name: string, text: string): string =>
  `## Skill: ${name}\n\n${frontmatter(text).body.replace(/^<!--[^\n]*-->\n+/, "").trim()}\n`;

export interface Packed {
  /** Each part's sections, in the definition's order. */
  parts: string[][];
  /** Skills too big for a part, or past the last slot, with the file to Read instead. */
  overflow: { name: string; path: string }[];
  /** Skills the definition lists that this plugin doesn't have. */
  missing: string[];
}

/** The definition's skills, packed in order into parts of at most `budget` characters each. */
export function pack(pluginRoot: string, definition: string, budget = SLOT_BUDGET, slots = SLOTS): Packed {
  const packed: Packed = { parts: [], overflow: [], missing: [] };
  let size = budget;
  for (const name of declaredSkills(definition)) {
    const path = skillPath(pluginRoot, name);
    if (!path || !existsSync(path)) {
      packed.missing.push(name);
      continue;
    }
    const section = skillSection(name, readFileSync(path, "utf8"));
    if (section.length > budget) {
      packed.overflow.push({ name, path });
      continue;
    }
    if (size + section.length > budget) {
      if (packed.parts.length === slots) {
        packed.overflow.push({ name, path });
        continue;
      }
      packed.parts.push([]);
      size = 0;
    }
    packed.parts.at(-1)?.push(section);
    size += section.length;
  }
  return packed;
}

/**
 * What slot `slot` (1-based) injects for this agent, or null when it has nothing. The first part's header also
 * names any skill that couldn't be injected, so a gap is said, never silent.
 */
export function slotContext(pluginRoot: string, agentType: string, slot: number): string | null {
  const path = definitionPath(pluginRoot, agentType);
  if (!path || !existsSync(path)) return null;
  const { parts, overflow, missing } = pack(pluginRoot, readFileSync(path, "utf8"));
  const sections = parts[slot - 1];
  if (!sections && !(slot === 1 && (overflow.length || missing.length))) return null;

  const header = [`Harness skills for ${agentType}, part ${slot} of ${Math.max(parts.length, 1)}: preloaded from the skills: list in its definition.`];
  if (slot === 1) {
    for (const o of overflow) header.push(`Not injected, too large: ${o.name}. Read ${o.path.replace(/\\/g, "/")} before you plan.`);
    for (const m of missing) header.push(`Missing from the plugin: ${m}. Tell the person before you plan.`);
  }
  return [header.join("\n"), ...(sections ?? [])].join("\n\n");
}
