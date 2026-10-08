// The intake gate (ANY-REPO.md, H4): no Harness agent works on a plan until its brief is clear enough.
// The orchestrator scores the brief's ambiguity on the rubric's 0-2 scale and records each round as a
// plan.intake event; this decides, from those events, whether a plan may start.
//
// The threshold is routing.yaml's (intake.max_ambiguity), never the one an event carries, so the
// orchestrator can't lower its own bar. The score itself is still the orchestrator's judgment: the gate
// guarantees the intake happened and came in under the bar, and the brief it leaves in PLAN.md, with the
// questions the person answered, is what keeps the score honest.
import { taskIdsIn } from "./ids.ts";
import type { HarnessEvent } from "./types.ts";

interface IntakeData {
  round: number;
  ambiguity: number;
  questions: number;
  settled: boolean;
  review?: { verdict: string; by: string; reason?: string };
}

/** The plan a task id belongs to: PLAN-7.2 is PLAN-7's. */
export const planOf = (taskId: string): string => taskId.replace(/\..*$/, "");

/** Whether a plan may start: its latest plan.intake is under the threshold, or a person overruled it. */
export function intakeVerdict(planId: string, maxAmbiguity: number, events: readonly HarnessEvent[]): { allowed: boolean; detail: string } {
  const rounds = events.filter((e) => e.type === "plan.intake" && e.plan_id === planId);
  const latest = rounds.at(-1);
  if (!latest) {
    return { allowed: false, detail: `${planId} has had no intake: write its brief (goal, success signals, boundaries, decisions), score its ambiguity, and record plan.intake before any agent starts` };
  }
  const data = latest.data as unknown as IntakeData;
  if (data.review?.verdict === "overruled" && data.review.by === "human") {
    return { allowed: true, detail: `${planId}'s intake was overruled by the person: ${data.review.reason ?? "no reason given"}` };
  }
  if (Number.isInteger(data.ambiguity) && data.ambiguity <= maxAmbiguity) {
    return { allowed: true, detail: `${planId}'s brief scored ambiguity ${data.ambiguity} (at most ${maxAmbiguity})` };
  }
  return {
    allowed: false,
    detail: `${planId}'s brief still scores ambiguity ${String(data.ambiguity)}, over the ${maxAmbiguity} routing.yaml allows: ask the person the open questions, update the brief, score it again and record the new round (or record their overrule, with their reason)`,
  };
}

/**
 * The plans an agent call is for, from the task ids its prompt names ("WRITE-TESTS: PLAN-7.2"). Every
 * dispatch the orchestrator makes names its task, so a call naming none is refused rather than guessed.
 */
export const plansIn = (prompt: unknown): string[] => [...new Set(taskIdsIn(prompt).map(planOf))];
