// Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeRules, describeRule, evaluate, evaluateRule, type Rule, type WorkMap } from "./rules.ts";
import { addVersion, clampToVocabulary, gapQuestions, manualDraft } from "./workmap.ts";

const ev = { quote: "Equipment over 5,000 euros is always capex.", source: "live question" as const, t: "03:15", frameId: 118 };

const R1: Rule = {
  id: "R1", scope: { itemType: "equipment" }, when: [{ field: "amount", op: "gt", value: 5000 }],
  require: { field: "account", value: "0400 Capex" }, block: "Equipment over 5,000 euros is always capex.",
  escalation: null, evidence: ev, status: "confirmed",
};
const R2: Rule = {
  id: "R2", scope: { itemType: "equipment" },
  when: [{ field: "account", op: "eq", value: "0400 Capex" }, { field: "assetNumber", op: "missing" }],
  require: null, block: "No asset number, no capex booking.", escalation: "Ask the controller",
  evidence: { ...ev, quote: "No asset number, I don't book it as capex.", source: "debrief", t: "06:40", frameId: 131 }, status: "confirmed",
};
const R3: Rule = {
  id: "R3", scope: { supplier: "Kessler Logistik" }, when: [{ field: "month", op: "eq", value: "December" }],
  require: { field: "paymentStatus", value: "On hold" }, block: "Kessler double-bills every December.",
  escalation: "Only the controller releases the hold", evidence: { ...ev, quote: "Kessler double-bills every December.", t: "02:10", frameId: 90 }, status: "confirmed",
};
const RULES = [R1, R2, R3];

test("brief test table: €7,200 equipment on Opex → R1 blocks", () => {
  const v = evaluate(RULES, { itemType: "equipment", amount: 7200, account: "4711 Opex", assetNumber: null, supplier: "Hoffmann", month: "April", paymentStatus: "Scheduled" });
  assert.equal(v.find((x) => x.ruleId === "R1")!.outcome, "fail");
  assert.equal(v.find((x) => x.ruleId === "R3")!.outcome, "not-applicable");
});

test("brief test table: capex without asset number → R2 blocks with escalation", () => {
  const v = evaluateRule(R2, { itemType: "equipment", amount: 7200, account: "0400 Capex", assetNumber: null });
  assert.equal(v.outcome, "fail");
  assert.equal(v.escalation, "Ask the controller");
});

test("brief test table: €4,800 Opex → R1 does not fire (tutor stays silent, no praise)", () => {
  assert.equal(evaluateRule(R1, { itemType: "equipment", amount: 4800, account: "4711 Opex" }).outcome, "not-applicable");
});

test("brief test table: exactly €5,000 is NOT covered by 'over 5,000' — never guessed", () => {
  assert.equal(evaluateRule(R1, { itemType: "equipment", amount: 5000, account: "4711 Opex" }).outcome, "not-applicable");
});

test("brief test table: Kessler December not on hold → R3 blocks; March → silent", () => {
  assert.equal(evaluateRule(R3, { supplier: "Kessler Logistik", month: "December", paymentStatus: "Scheduled" }).outcome, "fail");
  assert.equal(evaluateRule(R3, { supplier: "Kessler Logistik", month: "March", paymentStatus: "Scheduled" }).outcome, "not-applicable");
});

test("brief test table: unknown situation → 'check with a person', with taught escalation only", () => {
  const v = evaluateRule(R1, { itemType: "equipment", account: "4711 Opex" }); // amount missing
  assert.equal(v.outcome, "unknown-field");
  assert.match(v.message!, /Check with a person/);
});

test("threshold proof: v2 (€4,000) blocks a €4,500 opex buy; v1 is no longer active", () => {
  const v1Map: WorkMap = { workMap: "invoice-processing", version: 1, supersedes: null, expert: "Sabine", confirmed: true, steps: [], rules: [R1], openQuestions: [] };
  const r1v2: Rule = { ...R1, when: [{ field: "amount", op: "gt", value: 4000 }], evidence: { ...ev, quote: "Actually, it's 4,000 now.", source: "correction", t: "00:12", frameId: null } };
  let maps = [v1Map];
  maps = addVersion(maps, { ...v1Map, rules: [r1v2], confirmed: true });
  const active = maps[maps.length - 1]!;
  assert.equal(active.version, 2);
  assert.equal(active.supersedes, 1);
  const rec = { itemType: "equipment", amount: 4500, account: "4711 Opex" };
  assert.equal(evaluateRule(active.rules[0]!, rec).outcome, "fail"); // v2 blocks
  assert.equal(evaluateRule(R1, rec).outcome, "not-applicable"); // v1 wouldn't have
});

test("only confirmed rules of a confirmed map are enforced", () => {
  const draft: WorkMap = { workMap: "x", version: 1, supersedes: null, expert: "S", confirmed: false, steps: [], rules: [R1], openQuestions: [] };
  assert.equal(activeRules(draft).length, 0);
  const confirmed = { ...draft, confirmed: true, rules: [R1, { ...R2, status: "proposed" as const }] };
  assert.deepEqual(activeRules(confirmed).map((r) => r.id), ["R1"]);
});

test("vocabulary clamp: out-of-vocabulary rule becomes an open question, never a rule", () => {
  const bad: Rule = { ...R1, id: "RX", when: [{ field: "vendorCountry", op: "eq", value: "CZ" }] };
  const map: WorkMap = { workMap: "x", version: 1, supersedes: null, expert: "S", confirmed: false, steps: [{ n: 1, title: "t", decision: "d", frameId: null, t: "00:01", ruleIds: ["RX", "R1"] }], rules: [R1, bad], openQuestions: [] };
  const { map: clamped, downgraded } = clampToVocabulary(map);
  assert.deepEqual(downgraded, ["RX"]);
  assert.deepEqual(clamped.rules.map((r) => r.id), ["R1"]);
  assert.deepEqual(clamped.steps[0]!.ruleIds, ["R1"]);
  assert.match(clamped.openQuestions[0]!.q, /RX/);
});

test("manual draft keeps every expert answer as evidence and invents nothing", () => {
  const draft = manualDraft([
    { kind: "app", text: 'Account changed "4711 Opex" → "0400 Capex" on INV-4471 (Hoffmann, €6,850)', t: 1, frameId: 7 },
    { kind: "expert", text: "Got it — over five thousand is capex.", t: 2, frameId: 7 },
    { kind: "vision", text: "Payment status set to On hold", t: 3 },
  ], "Sabine");
  assert.equal(draft.rules.length, 0);
  assert.equal(draft.steps.length, 1);
  assert.match(draft.openQuestions[0]!.q, /over five thousand/);
});

test("debrief gaps: boundary question for every threshold, guardrail question when none taught", () => {
  const noEscalation: WorkMap = { workMap: "x", version: 1, supersedes: null, expert: "S", confirmed: false, steps: [], rules: [{ ...R1, escalation: null }], openQuestions: [] };
  const gaps = gapQuestions(noEscalation);
  assert.ok(gaps.some((g) => /stop and ask someone/.test(g)));
  assert.ok(gaps.some((g) => /exactly €5,000/.test(g)));
});

test("plain-language rendering matches the product wording", () => {
  assert.equal(describeRule(R1), 'When item type is "equipment" and amount is over €5,000, account must be "0400 Capex".');
});
