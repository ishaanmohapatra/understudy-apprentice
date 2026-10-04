// Work Map store: versions in localStorage (brief: browser storage, sessions
// survive refresh). A new confirmation supersedes the previous version in the
// same scope — both are never active. Includes the no-AI draft builder so the
// whole loop works before any key is configured; /api/extract upgrades drafts
// when ANTHROPIC_API_KEY exists.
import { FIELD_VOCABULARY, ruleVocabularyErrors, type OpenQuestion, type Rule, type WorkMap, type WorkMapStep } from "./rules.ts";

const KEY = "understudy.workmaps";

export function loadMaps(): WorkMap[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as WorkMap[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveMaps(maps: WorkMap[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(maps)); } catch { /* storage may be blocked; demo keeps in-memory state */ }
}

export function latestMap(maps: WorkMap[]): WorkMap | null {
  return maps.length ? maps[maps.length - 1]! : null;
}

export function activeMap(maps: WorkMap[]): WorkMap | null {
  const m = latestMap(maps);
  return m && m.confirmed ? m : null;
}

/** Confirming a draft makes it the one active version; the previous version
 *  is superseded by construction (only the latest confirmed map is served). */
export function addVersion(maps: WorkMap[], draft: Omit<WorkMap, "version" | "supersedes">): WorkMap[] {
  const prev = latestMap(maps);
  const next: WorkMap = { ...draft, version: (prev?.version ?? 0) + 1, supersedes: prev?.confirmed ? prev.version : prev?.supersedes ?? null };
  return [...maps, next];
}

/** Vocabulary clamp: any rule using unknown fields becomes an open question,
 *  never a guessed rule. Applied to BOTH the LLM path and manual edits. */
export function clampToVocabulary(map: WorkMap): { map: WorkMap; downgraded: string[] } {
  const downgraded: string[] = [];
  const rules = map.rules.filter((r) => {
    const errs = ruleVocabularyErrors(r);
    if (errs.length === 0) return true;
    downgraded.push(r.id);
    map.openQuestions.push({
      q: `Proposed rule ${r.id} used fields outside the vocabulary (${errs.join(", ")}; allowed: ${FIELD_VOCABULARY.join(", ")}). Ask Sabine to restate it.`,
      status: "unresolved",
      deferredTo: null,
    });
    return false;
  });
  const ids = new Set(rules.map((r) => r.id));
  const steps = map.steps.map((s) => ({ ...s, ruleIds: s.ruleIds.filter((id) => ids.has(id)) }));
  return { map: { ...map, rules, steps }, downgraded };
}

export type SessionEntryLite = {
  kind: "app" | "vision" | "expert" | "agent";
  text: string;
  t: number;
  frameId?: number;
};

/** No-AI draft: steps from the captured app events, every expert answer kept
 *  as evidence in open questions for the reviewer to turn into rules. Honest
 *  fallback — it never invents a rule. */
export function manualDraft(entries: SessionEntryLite[], expert: string): WorkMap {
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
  const steps: WorkMapStep[] = entries
    .filter((e) => e.kind === "app")
    .map((e, i) => ({ n: i + 1, title: e.text.split(" on ")[0]?.slice(0, 60) ?? "Step", decision: e.text, frameId: e.frameId ?? null, t: clock(e.t), ruleIds: [] }));
  const answers = entries.filter((e) => e.kind === "expert");
  const openQuestions: OpenQuestion[] = answers.length
    ? answers.map((a) => ({ q: `Sabine said: "${a.text}" — turn this into a rule if it states one.`, status: "unresolved" as const, deferredTo: null }))
    : [{ q: "No spoken answers were captured. Record a session with voice, or add rules by hand in Review.", status: "unresolved", deferredTo: null }];
  return { workMap: "invoice-processing", version: 0, supersedes: null, expert, confirmed: false, steps, rules: [], openQuestions };
}

/** Gap list for the spoken debrief, ranked per the brief: unanswered
 *  guardrails first, then unclear thresholds, then unseen cases. */
export function gapQuestions(map: WorkMap): string[] {
  const gaps: string[] = [];
  if (!map.rules.some((r) => r.escalation)) {
    gaps.push("When would you stop and ask someone — and who is it for this process?");
  }
  for (const r of map.rules) {
    for (const c of r.when) {
      if (c.op === "gt" || c.op === "lt") {
        gaps.push(`You said ${describeThreshold(c)}. What about exactly ${fmtVal(c)}?`);
      }
    }
  }
  gaps.push("You held the December invoice. Is that every supplier, and who releases it?");
  for (const q of map.openQuestions.filter((x) => x.status === "unresolved").slice(0, 2)) gaps.push(q.q);
  return [...new Set(gaps)].slice(0, 5);
}

const fmtVal = (c: { field: string; value?: unknown }) =>
  c.field === "amount" && typeof c.value === "number" ? `€${c.value.toLocaleString("en-IE")}` : String(c.value);
const describeThreshold = (c: { field: string; op: string; value?: unknown }) =>
  `${c.op === "gt" ? "over" : "under"} ${fmtVal(c)}`;
