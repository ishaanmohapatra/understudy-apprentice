// Run with: npm test  (node --test with type stripping)
import { test } from "node:test";
import assert from "node:assert/strict";
import { appTopic, buildNudgeMessage, decideNudge, visionTopic, type GateInput } from "./pauseGate.ts";

const T = 1_000_000;
const base: GateInput = {
  now: T,
  connected: true,
  offRecord: false,
  holdUntil: 0,
  lastActivity: T - 5000,
  lastSpeech: T - 5000,
  agentSpeaking: false,
  lastNudge: T - 60000,
  pauseMs: 2500,
  speechQuietMs: 1500,
  cooldownMs: 20000,
  pending: [{ topic: appTopic("INV-4471", "Cost center"), text: "Cost center 4711 → 0400" }],
  askedTopics: new Set<string>(),
};

test("nudges when idle, quiet, cooled down, with a fresh topic", () => {
  const d = decideNudge(base);
  assert.equal(d.action, "nudge");
  if (d.action === "nudge") {
    assert.equal(d.events.length, 1);
    assert.equal(d.dropped.length, 0);
  }
});

test("waits while the expert is typing (activity within pauseMs)", () => {
  const d = decideNudge({ ...base, lastActivity: T - 500 });
  assert.deepEqual(d, { action: "wait", reason: "active" });
});

test("waits while the expert is speaking (VAD within speechQuietMs)", () => {
  const d = decideNudge({ ...base, lastSpeech: T - 1000 });
  assert.deepEqual(d, { action: "wait", reason: "speaking" });
});

test("waits while the agent itself is speaking", () => {
  const d = decideNudge({ ...base, agentSpeaking: true });
  assert.deepEqual(d, { action: "wait", reason: "agent-speaking" });
});

test("respects the question cooldown", () => {
  const d = decideNudge({ ...base, lastNudge: T - 10000 });
  assert.deepEqual(d, { action: "wait", reason: "cooldown" });
});

test("cooldown boundary: exactly cooldownMs since last nudge is allowed", () => {
  const d = decideNudge({ ...base, lastNudge: T - 20000 });
  assert.equal(d.action, "nudge");
});

test("never nudges with no pending events", () => {
  const d = decideNudge({ ...base, pending: [] });
  assert.deepEqual(d, { action: "wait", reason: "no-events" });
});

test("off the record blocks nudges entirely", () => {
  const d = decideNudge({ ...base, offRecord: true });
  assert.deepEqual(d, { action: "wait", reason: "off-record" });
});

test("disconnected blocks nudges", () => {
  const d = decideNudge({ ...base, connected: false });
  assert.deepEqual(d, { action: "wait", reason: "disconnected" });
});

test("'Give me a moment' holds questions until holdUntil passes", () => {
  const holding = decideNudge({ ...base, holdUntil: T + 30000 });
  assert.deepEqual(holding, { action: "wait", reason: "holding" });
  const expired = decideNudge({ ...base, holdUntil: T - 1 });
  assert.equal(expired.action, "nudge");
});

test("already-asked topics are dropped from a nudge", () => {
  const asked = new Set([appTopic("INV-4471", "Cost center")]);
  const fresh = { topic: appTopic("INV-4471", "Category"), text: "Category → Capital expenditure" };
  const d = decideNudge({ ...base, askedTopics: asked, pending: [...base.pending, fresh] });
  assert.equal(d.action, "nudge");
  if (d.action === "nudge") {
    assert.deepEqual(d.events, [fresh]);
    assert.equal(d.dropped.length, 1);
  }
});

test("when every pending topic was already asked, nothing is sent", () => {
  const asked = new Set([appTopic("INV-4471", "Cost center")]);
  const d = decideNudge({ ...base, askedTopics: asked });
  assert.equal(d.action, "drop-asked");
  if (d.action === "drop-asked") assert.equal(d.dropped.length, 1);
});

test("app topic is per invoice + field, case-insensitive on the field", () => {
  assert.equal(appTopic("INV-1", "Cost Center"), appTopic("INV-1", "cost center"));
  assert.notEqual(appTopic("INV-1", "Cost center"), appTopic("INV-2", "Cost center"));
});

test("vision topic collapses the same field changing back and forth", () => {
  const a = visionTopic("Cost center field changed from 4711 to 0400 on invoice INV-4471");
  const b = visionTopic("Cost center field changed from 0400 to 4711 on invoice INV-4471");
  assert.equal(a, b);
  const c = visionTopic("Category changed to Capital expenditure");
  assert.notEqual(a, c);
});

test("nudge message is clearly labeled as an app signal, not speech", () => {
  const msg = buildNudgeMessage(base.pending, 3100);
  assert.ok(msg.startsWith("[APP SIGNAL"));
  assert.ok(msg.includes("NOT spoken by the expert"));
  assert.ok(msg.includes("3.1s"));
  assert.ok(msg.includes("Cost center 4711 → 0400"));
  assert.ok(msg.includes("skip_turn"));
});
