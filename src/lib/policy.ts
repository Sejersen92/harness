// The routing policy PreviouslyUpcoming sets for a repository: mode and each tier's model and effort.
// harness-policy applies it to the home's routing.yaml and records what it applied in
// <home>/state/policy.json. Only the owned keys change; every other byte of routing.yaml stays as it
// was, so config_sha256 moves only when the policy really changes something.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, parseDocument, type Scalar } from "yaml";
import { utcNow } from "./ids.ts";

export const POLICY_MODES = ["observe", "route"] as const;
export const MODELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const TIER_NAMES = ["T1", "T2", "T3", "T4"] as const;

export type PolicyMode = (typeof POLICY_MODES)[number];
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];
export type TierName = (typeof TIER_NAMES)[number];
export interface TierPolicy { model: Model; effort: Effort }

/** What `apply --json` takes. */
export interface Policy {
  revision: number;
  mode: PolicyMode;
  tiers: Record<TierName, TierPolicy>;
  updatedBy: string;
}

/** <home>/state/policy.json: the policy last applied here, and when. */
export interface PolicyState extends Policy { appliedAt: string }

const POLICY_KEYS = ["revision", "mode", "tiers", "updatedBy"];
const TIER_KEYS = ["model", "effort"];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extraKey = (value: Record<string, unknown>, allowed: readonly string[]): string | undefined =>
  Object.keys(value).find((key) => !allowed.includes(key));

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The text with every control character (U+0000-U+001F, U+007F) replaced, so it prints on one line. */
export const oneLineText = (text: string): string => text.replace(new RegExp(CONTROL.source, "g"), "?");

/**
 * Strict: exactly the policy's keys, exact enums, T1-T4 and nothing else; updatedBy holds no control
 * character, so whatever is recorded prints on one line.
 */
export function validatePolicy(input: unknown): { ok: true; policy: Policy } | { ok: false; why: string } {
  const checked = validateShape(input);
  if (!checked.ok) return checked;
  const control = CONTROL.exec(checked.policy.updatedBy);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0");
    return { ok: false, why: `updatedBy must not contain a control character (it holds U+${code})` };
  }
  return checked;
}

/** The policy's shape without the control-character rule: policy.json read back for show is lenient there. */
function validateShape(input: unknown): { ok: true; policy: Policy } | { ok: false; why: string } {
  const no = (why: string) => ({ ok: false as const, why });
  if (!isObject(input)) return no("the policy is not a JSON object");
  const extra = extraKey(input, POLICY_KEYS);
  if (extra !== undefined) return no(`unknown key ${JSON.stringify(extra)} in the policy`);

  const { revision, mode, tiers, updatedBy } = input;
  if (revision === undefined) return no("revision is missing");
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    return no(`revision must be an integer of at least 1, not ${JSON.stringify(revision)}`);
  }
  if (mode === undefined) return no("mode is missing");
  if (mode === "off") return no("mode off is not set by policy; use observe or route");
  if (!oneOf(POLICY_MODES, mode)) return no(`unknown mode ${JSON.stringify(mode)}; use ${POLICY_MODES.join(" or ")}`);
  if (updatedBy === undefined) return no("updatedBy is missing");
  if (typeof updatedBy !== "string" || updatedBy.trim() === "") return no("updatedBy must be a non-empty string");

  if (tiers === undefined) return no("tiers is missing");
  if (!isObject(tiers)) return no("tiers is not an object");
  const extraTier = extraKey(tiers, TIER_NAMES);
  if (extraTier !== undefined) return no(`unknown tier ${JSON.stringify(extraTier)}; the tiers are ${TIER_NAMES.join(", ")}`);
  for (const name of TIER_NAMES) {
    const tier = tiers[name];
    if (tier === undefined) return no(`tier ${name} is missing`);
    if (!isObject(tier)) return no(`tier ${name} is not an object`);
    const extraInTier = extraKey(tier, TIER_KEYS);
    if (extraInTier !== undefined) return no(`unknown key ${JSON.stringify(extraInTier)} in tier ${name}`);
    if (tier.model === undefined) return no(`tier ${name} has no model`);
    if (!oneOf(MODELS, tier.model)) return no(`unknown model ${JSON.stringify(tier.model)} in tier ${name}; use ${MODELS.join(", ")}`);
    if (tier.effort === undefined) return no(`tier ${name} has no effort`);
    if (!oneOf(EFFORTS, tier.effort)) return no(`unknown effort ${JSON.stringify(tier.effort)} in tier ${name}; use ${EFFORTS.join(", ")}`);
  }
  const t = tiers as Record<TierName, TierPolicy>;
  return {
    ok: true,
    policy: {
      revision,
      mode,
      tiers: Object.fromEntries(TIER_NAMES.map((n) => [n, { model: t[n].model, effort: t[n].effort }])) as Record<TierName, TierPolicy>,
      updatedBy,
    },
  };
}

/** An owned key's path in routing.yaml and a readable name for it. */
const OWNED: readonly { path: string[]; name: string; of: (p: Policy) => string }[] = [
  { path: ["mode"], name: "mode", of: (p) => p.mode },
  ...TIER_NAMES.flatMap((tier) => [
    { path: ["tiers", tier, "model"], name: `${tier} model`, of: (p: Policy) => p.tiers[tier].model },
    { path: ["tiers", tier, "effort"], name: `${tier} effort`, of: (p: Policy) => p.tiers[tier].effort },
  ]),
];

/** An owned key's current value and where its scalar sits in the text ([start, end) of the value). */
interface Located { name: string; value: string; start: number; end: number; of: (p: Policy) => string }

/** Finds each owned key's scalar node in routing.yaml's text, with its source range. */
function locateOwned(text: string): { ok: true; owned: Located[] } | { ok: false; why: string } {
  const doc = parseDocument(text);
  const [error] = doc.errors;
  if (error) return { ok: false, why: `routing.yaml does not parse: ${error.message.split("\n")[0]}` };
  const owned: Located[] = [];
  for (const key of OWNED) {
    const parent = key.path.length > 1 ? doc.getIn(key.path.slice(0, -1), true) : doc.contents;
    const node = isMap(parent) ? parent.get(key.path[key.path.length - 1], true) : undefined;
    if (!isScalar(node) || !node.range) return { ok: false, why: `routing.yaml has no ${key.path.join(".")} to set` };
    const scalar = node as Scalar;
    owned.push({ name: key.name, value: String(scalar.value), start: scalar.range![0], end: scalar.range![1], of: key.of });
  }
  return { ok: true, owned };
}

/**
 * routing.yaml's text with the policy's values in its owned keys. The Document API finds the nodes;
 * the new values are spliced into the original text at their source ranges, so comments, aligned
 * spacing and flow-style maps keep every byte. A value that already matches is not touched.
 */
export function renderRouting(text: string, policy: Policy):
  { ok: true; text: string; current: Record<string, string> } | { ok: false; why: string } {
  const located = locateOwned(text);
  if (!located.ok) return located;
  const current = Object.fromEntries(located.owned.map((o) => [o.name, o.value]));
  const edits = located.owned
    .map((o) => ({ ...o, next: o.of(policy) }))
    .filter((o) => o.value !== o.next)
    .sort((a, b) => b.start - a.start);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.next + out.slice(edit.end);
  return { ok: true, text: out, current };
}

const statePath = (home: string): string => join(home, "state", "policy.json");

/** The policy last applied here, or null when there is none (or it can't be read). */
export function readState(home: string): PolicyState | null {
  const path = statePath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isObject(raw) || typeof raw.appliedAt !== "string") return null;
    const { appliedAt, ...rest } = raw;
    const checked = validateShape(rest);
    return checked.ok ? { ...checked.policy, appliedAt } : null;
  } catch {
    return null;
  }
}

function writeState(home: string, state: PolicyState): void {
  const path = statePath(home);
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}

const sameValues = (a: Policy, b: Policy): boolean =>
  a.mode === b.mode && TIER_NAMES.every((t) => a.tiers[t].model === b.tiers[t].model && a.tiers[t].effort === b.tiers[t].effort);

const summary = (p: Policy): string =>
  [p.mode, ...TIER_NAMES.map((t) => `${t} ${p.tiers[t].model}/${p.tiers[t].effort}`)].join(" · ");

/** show's one line; control characters from a hand-edited policy.json are replaced so it stays one line. */
export const showLine = (state: PolicyState | null): string =>
  oneLineText(state ? `rev ${state.revision} · ${summary(state)} (set by ${state.updatedBy}, ${state.appliedAt})` : "none · no policy applied here");

export interface ApplyOutcome { line: string; code: 0 | 1 }

const errorCode = (error: unknown): string =>
  (error as NodeJS.ErrnoException)?.code ?? (error instanceof Error ? error.message : String(error));

/**
 * Applies a validated policy to <home>/routing.yaml, then records it in <home>/state/policy.json.
 * routing.yaml is written only when its bytes change; policy.json only after routing.yaml is in place.
 */
export function applyPolicy(home: string, policy: Policy, now: Date = new Date()): ApplyOutcome {
  const routingPath = join(home, "routing.yaml");
  const text = readFileSync(routingPath, "utf8");
  const rendered = renderRouting(text, policy);
  if (!rendered.ok) return { line: `refused: ${rendered.why}`, code: 1 };

  const state = readState(home);
  // A hand edit: an owned key that differs from what was last applied here and that this apply replaces.
  const handEdits = state
    ? OWNED.filter((k) => rendered.current[k.name] !== k.of(state) && rendered.current[k.name] !== k.of(policy))
      .map((k) => `${k.name} was ${rendered.current[k.name]}`)
    : [];

  const routingChanges = rendered.text !== text;
  const recorded = state !== null && state.revision === policy.revision && state.updatedBy === policy.updatedBy && sameValues(state, policy);
  if (!routingChanges && recorded) return { line: `unchanged · rev ${policy.revision} is already applied`, code: 0 };

  if (routingChanges) {
    try {
      writeFileSync(routingPath, rendered.text);
    } catch (error) {
      return { line: `refused: routing.yaml could not be written (${errorCode(error)}); nothing was applied`, code: 1 };
    }
  }
  try {
    writeState(home, { ...policy, appliedAt: utcNow(now) });
  } catch (error) {
    return { line: `failed: routing.yaml holds rev ${policy.revision} but state/policy.json could not be written (${errorCode(error)})`, code: 1 };
  }

  if (handEdits.length) {
    return {
      line: `hand edit replaced by rev ${policy.revision} (routing.yaml's ${handEdits.join(", ")}); change the policy with pu harness mode`,
      code: 0,
    };
  }
  return { line: `applied rev ${policy.revision} · ${summary(policy)}`, code: 0 };
}
