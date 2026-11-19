// tests.written (LN1, 0.20.0): what the evaluator's WRITE-TESTS run reports, per acceptance criterion: the tests it
// wrote, their file, and why each failed before the code existed. The dispatcher records it from the report, so it is
// the evaluator's account ("reported"), not a proof; green is still proven by harness-eval.
//
// The dispatcher is a model and can't count bytes, so harness-emit normalizes the report to what the schema allows
// and splits it into parts that each fit one 4 KB spool line. A report is never refused for its size or wording.

export const MAX_RED = 160;
export const MAX_TESTS = 10;
const MAX_TEST_NAME = 200;
const MAX_FILE = 200;
/** Room left for the envelope (ids, hashes, producer, repo) and the part counters, within one 4 KB line. */
const MAX_DATA_BYTES = 3200;

export interface TestsForAc { ac: string; tests: string[]; file?: string; red?: string }
export interface Untestable { ac: string; how: string }
export interface TestsWritten { acs: TestsForAc[]; untestable: Untestable[]; gaps: number }
export interface TestsWrittenPart extends TestsWritten { part: number; parts: number }

const cut = (value: unknown, max: number): string => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
};

/** The report as the schema allows it: at most 10 tests per criterion, reasons cut to 160 characters. */
export function normalizeTestsWritten(data: Record<string, unknown>): TestsWritten {
  const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const acs = list(data.acs).map((a): TestsForAc => {
    const item: TestsForAc = {
      ac: String(a.ac ?? ""),
      tests: (Array.isArray(a.tests) ? a.tests : []).map((t) => cut(t, MAX_TEST_NAME)).filter(Boolean).slice(0, MAX_TESTS),
    };
    if (a.file) item.file = cut(a.file, MAX_FILE);
    if (a.red) item.red = cut(a.red, MAX_RED);
    return item;
  });
  const untestable = list(data.untestable).map((u): Untestable => ({ ac: String(u.ac ?? ""), how: cut(u.how, MAX_RED) }));
  const gaps = Number.isInteger(data.gaps) && (data.gaps as number) >= 0 ? (data.gaps as number) : 0;
  return { acs, untestable, gaps };
}

/**
 * The report in parts that each fit one line, criteria in order and none repeated. Untestable criteria and the gap
 * count go on the first part only, so a consumer that adds the parts up counts each once.
 */
export function splitTestsWritten(data: Record<string, unknown>, maxDataBytes = MAX_DATA_BYTES): TestsWrittenPart[] {
  const report = normalizeTestsWritten(data);
  const size = (p: TestsWritten): number => Buffer.byteLength(JSON.stringify({ part: 99, parts: 99, ...p }));
  const groups: TestsWritten[] = [];
  let current: TestsWritten = { acs: [], untestable: report.untestable, gaps: report.gaps };
  for (const ac of report.acs) {
    const next = { ...current, acs: [...current.acs, ac] };
    // A criterion that doesn't fit with the ones before it starts a new part. One too big alone still goes, alone:
    // the spool then refuses that line and counts it, which is better than dropping the criterion silently here.
    if (current.acs.length > 0 && size(next) > maxDataBytes) {
      groups.push(current);
      current = { acs: [ac], untestable: [], gaps: 0 };
    } else {
      current = next;
    }
  }
  groups.push(current);
  return groups.map((g, i) => ({ part: i + 1, parts: groups.length, ...g }));
}
