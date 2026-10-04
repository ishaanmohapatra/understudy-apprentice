// Rule DSL + deterministic evaluator + plain-language rendering.
// Self-contained port of the engine proven in the Understudy product repo
// (same golden semantics; trimmed to what the demo needs). The voice
// explains; THIS code enforces — never the LLM on stage.

export type FieldValue = string | number | boolean | null;
export type RecordValues = Record<string, FieldValue>;

export type Condition = { field: string; op: "eq" | "gt" | "lt" | "in" | "missing"; value?: FieldValue | (string | number)[] };

export type Evidence = { quote: string; source: "live question" | "debrief" | "correction"; t: string; frameId: number | null };

export type Rule = {
  id: string;
  scope: Record<string, string | number | boolean>;
  when: Condition[];
  require: { field: string; value: string | number | boolean } | null;
  block: string;
  escalation: string | null;
  evidence: Evidence;
  status: "proposed" | "corrected" | "confirmed";
};

export type WorkMapStep = {
  n: number;
  title: string;
  decision: string;
  frameId: number | null;
  t: string;
  ruleIds: string[];
};

export type OpenQuestion = { q: string; status: "answered" | "deferred" | "unresolved"; deferredTo: string | null };

export type WorkMap = {
  workMap: string;
  version: number;
  supersedes: number | null;
  expert: string;
  confirmed: boolean;
  steps: WorkMapStep[];
  rules: Rule[];
  openQuestions: OpenQuestion[];
};

/** The closed vocabulary the extractor may use. Anything else becomes an
 *  open question, never a guessed rule. */
export const FIELD_VOCABULARY = [
  "amount", "itemType", "supplier", "month", "entity",
  "account", "assetNumber", "approval", "paymentStatus",
] as const;

export function ruleVocabularyErrors(rule: Rule): string[] {
  const known = new Set<string>(FIELD_VOCABULARY);
  const errs: string[] = [];
  for (const f of Object.keys(rule.scope)) if (!known.has(f)) errs.push(`scope field "${f}"`);
  for (const c of rule.when) if (!known.has(c.field)) errs.push(`condition field "${c.field}"`);
  if (rule.require && !known.has(rule.require.field)) errs.push(`required field "${rule.require.field}"`);
  return errs;
}

/* ---------------- evaluator ---------------- */

export type VerdictOutcome = "pass" | "fail" | "not-applicable" | "unknown-field";
export type Verdict = { ruleId: string; outcome: VerdictOutcome; message?: string; escalation?: string };

type CondResult = true | false | "unknown";
const isMissing = (v: unknown) => v === undefined || v === null || v === "";

function evalCondition(c: Condition, record: RecordValues): CondResult {
  const v = record[c.field];
  if (c.op === "missing") return isMissing(v);
  if (!(c.field in record) || isMissing(v)) return "unknown";
  switch (c.op) {
    case "eq": return v === c.value;
    case "gt": return typeof v === "number" && typeof c.value === "number" ? v > c.value : "unknown";
    case "lt": return typeof v === "number" && typeof c.value === "number" ? v < c.value : "unknown";
    case "in": return Array.isArray(c.value) ? (c.value as (string | number)[]).includes(v as string | number) : "unknown";
  }
}

function evalAll(conds: Condition[], record: RecordValues): CondResult {
  let result: CondResult = true;
  for (const c of conds) {
    const r = evalCondition(c, record);
    if (r === false) return false;
    if (r === "unknown") result = "unknown";
  }
  return result;
}

export function evaluateRule(rule: Rule, record: RecordValues): Verdict {
  const scopeConds: Condition[] = Object.entries(rule.scope).map(([field, value]) => ({ field, op: "eq", value }));
  const inScope = evalAll(scopeConds, record);
  if (inScope === false) return { ruleId: rule.id, outcome: "not-applicable" };
  if (inScope === "unknown") return unknown(rule);
  const whenMet = evalAll(rule.when, record);
  if (whenMet === false) return { ruleId: rule.id, outcome: "not-applicable" };
  if (whenMet === "unknown") return unknown(rule);
  if (rule.require === null) {
    return { ruleId: rule.id, outcome: "fail", message: rule.block, escalation: rule.escalation ?? undefined };
  }
  const actual = record[rule.require.field];
  if (!(rule.require.field in record) || isMissing(actual)) return unknown(rule);
  if (actual === rule.require.value) return { ruleId: rule.id, outcome: "pass" };
  return { ruleId: rule.id, outcome: "fail", message: rule.block, escalation: rule.escalation ?? undefined };
}

function unknown(rule: Rule): Verdict {
  return {
    ruleId: rule.id,
    outcome: "unknown-field",
    message: "Sabine didn't cover this. Check with a person before saving.",
    escalation: rule.escalation ?? undefined,
  };
}

export function evaluate(rules: Rule[], record: RecordValues): Verdict[] {
  return rules.map((r) => evaluateRule(r, record));
}

/** Only confirmed rules of a confirmed map are ever enforced. */
export function activeRules(map: WorkMap | null): Rule[] {
  if (!map || !map.confirmed) return [];
  return map.rules.filter((r) => r.status === "confirmed");
}

/* ---------------- plain language ---------------- */

const label = (f: string) => f.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const fmt = (f: string, v: unknown) => (f === "amount" && typeof v === "number" ? `€${v.toLocaleString("en-IE")}` : `"${String(v)}"`);

export function describeCondition(c: Condition): string {
  switch (c.op) {
    case "eq": return `${label(c.field)} is ${fmt(c.field, c.value)}`;
    case "gt": return `${label(c.field)} is over ${fmt(c.field, c.value)}`;
    case "lt": return `${label(c.field)} is under ${fmt(c.field, c.value)}`;
    case "in": return `${label(c.field)} is one of ${(c.value as unknown[]).map((x) => fmt(c.field, x)).join(", ")}`;
    case "missing": return `${label(c.field)} is empty`;
  }
}

export function describeRule(rule: Rule): string {
  const conds = [
    ...Object.entries(rule.scope).map(([field, value]) => describeCondition({ field, op: "eq", value })),
    ...rule.when.map(describeCondition),
  ];
  const whenPart = conds.length ? `When ${conds.join(" and ")}` : "Always";
  const thenPart = rule.require
    ? `${label(rule.require.field)} must be ${fmt(rule.require.field, rule.require.value)}.`
    : `stop — ${rule.block}${/[.!?]$/.test(rule.block) ? "" : "."}`;
  const esc = rule.escalation ? ` If unsure: ${rule.escalation}.` : "";
  return `${whenPart}, ${thenPart}${esc}`;
}
