import { createHash, randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A 26-character ULID: 48 bits of milliseconds, then 80 random bits, Crockford base32. */
export function ulid(ms: number = Date.now()): string {
  let time = "";
  let t = BigInt(ms);
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD.charAt(Number(t % 32n)) + time;
    t /= 32n;
  }
  let rand = BigInt("0x" + randomBytes(10).toString("hex"));
  let tail = "";
  for (let i = 0; i < 16; i++) {
    tail = CROCKFORD.charAt(Number(rand % 32n)) + tail;
    rand /= 32n;
  }
  return time + tail;
}

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** RFC 3339 UTC with seconds precision, e.g. 2026-10-12T09:14:03Z. */
export const utcNow = (date: Date = new Date()): string => date.toISOString().replace(/\.\d{3}Z$/, "Z");

const TASK_ID = /PLAN-\d+(?:\.\d+)+/g;

/** Every task id in a piece of text, in order, without duplicates. */
export const taskIdsIn = (text: unknown): string[] => [...new Set(String(text ?? "").match(TASK_ID) ?? [])];

const REPORT = /^\s*(DONE|ESCALATE|PASS|FAIL|PLAN)\s*:\s*(.*)$/;

/**
 * Reads the report header every Harness agent must start its final message with,
 * e.g. "DONE: PLAN-7.2" or "PASS: PLAN-7.1, PLAN-7.2". Returns report "none" when absent.
 */
export function parseReport(message: unknown): { report: string; task_ids: string[] } {
  const firstLine = String(message ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
  const match = firstLine.match(REPORT);
  if (!match) return { report: "none", task_ids: [] };
  return { report: match[1] ?? "none", task_ids: taskIdsIn(match[2]) };
}
