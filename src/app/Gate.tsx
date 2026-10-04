"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appTopic, buildNudgeMessage, decideNudge, visionTopic, type PendingEvent } from "../lib/pauseGate";
import {
  activeRules, describeRule, evaluate, FIELD_VOCABULARY,
  type RecordValues, type Rule, type Verdict, type WorkMap,
} from "../lib/rules";
import { activeMap as pickActiveMap, addVersion, clampToVocabulary, gapQuestions, loadMaps, manualDraft, saveMaps } from "../lib/workmap";

/* ---------- tunables ---------- */
const FRAME_MS = 2000;
const VISION_EVERY = 2;
const SPEECH_QUIET_MS = 1500;
const VAD_SPEAKING = 0.6;
const HOLD_MS = 60000;

type Kind = "app" | "vision" | "signal" | "expert" | "agent" | "system";
type Entry = { id: number; t: number; kind: Kind; text: string; frameId?: number };
type Frame = { id: number; t: number; url: string };
type Invoice = { id: string; vendor: string; amount: string; category: string; costCenter: string; iban: string };
type Mode = "teach" | "review" | "train";
type Agent = "interviewer" | "tutor";

const KIND_LABEL: Record<Kind, string> = {
  app: "Screen · app event",
  vision: "Screen · vision",
  signal: "App signal (not speech)",
  expert: "Expert",
  agent: "Understudy",
  system: "System",
};

const START_INVOICE: Invoice = {
  id: "INV-4471",
  vendor: "Hoffmann Maschinenbau GmbH",
  amount: "6,850.00",
  category: "Operating expense",
  costCenter: "4711",
  iban: "DE89 3704 0044 0532 0130 00",
};

const TEACH_QUEUE = [
  { id: "INV-4471", vendor: "Hoffmann Maschinenbau GmbH", amount: "6,850.00" },
  { id: "INV-4472", vendor: "Kessler Logistik GmbH", amount: "1,240.00" },
  { id: "INV-4473", vendor: "Stroj Plzeň s.r.o.", amount: "3,100.00" },
];

type TrainCase = { id: string; vendor: string; hints: boolean; note: string; record: RecordValues };
const BASE_CASES: TrainCase[] = [
  {
    id: "INV-5001", vendor: "Hoffmann Maschinenbau GmbH", hints: true,
    note: "Unseen case: a €7,200 milling head.",
    record: { amount: 7200, itemType: "equipment", account: "4711 Opex", assetNumber: null, supplier: "Hoffmann Maschinenbau", month: "April", entity: "DE01", approval: "Standard", paymentStatus: "Scheduled" },
  },
  {
    id: "INV-5002", vendor: "Kessler Logistik GmbH", hints: false,
    note: "Hints off: Kessler, December.",
    record: { amount: 980, itemType: "service", account: "4711 Opex", assetNumber: null, supplier: "Kessler Logistik", month: "December", entity: "DE01", approval: "Standard", paymentStatus: "Scheduled" },
  },
];
const PROOF_CASE: TrainCase = {
  id: "INV-5003", vendor: "Hoffmann Maschinenbau GmbH", hints: false,
  note: "Threshold proof: €4,500 equipment — blocked only under v2.",
  record: { amount: 4500, itemType: "equipment", account: "4711 Opex", assetNumber: null, supplier: "Hoffmann Maschinenbau", month: "May", entity: "DE01", approval: "Standard", paymentStatus: "Scheduled" },
};

/** Typed turn: a real user message to the agent (for a hoarse expert — the
 *  agent still speaks; the pipeline treats typed text exactly like speech). */
function TypedTurn({ enabled, placeholder, onSend }: { enabled: boolean; placeholder: string; onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  if (!enabled) return null;
  const send = () => { const t = text.trim(); if (!t) return; onSend(t); setText(""); };
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
      <input style={{ flex: 1, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, font: "inherit" }}
        value={text} placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
      <button className="btn" onClick={send}>Send</button>
    </div>
  );
}

let nextId = 1;
const now = () => Date.now();
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
const isEditable = (t: EventTarget | null) => t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);

export default function Gate() {
  return (
    <ConversationProvider>
      <App />
    </ConversationProvider>
  );
}

function App() {
  /* ---------- shared state ---------- */
  const [mode, setMode] = useState<Mode>("teach");
  const [maps, setMaps] = useState<WorkMap[]>([]);
  const [draft, setDraft] = useState<WorkMap | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [shot, setShot] = useState<{ frameId: number; text: string; t: string } | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [voiceAgent, setVoiceAgent] = useState<Agent | null>(null);
  const [agentMode, setAgentMode] = useState<"listening" | "speaking">("listening");

  /* teach state */
  const [phase, setPhase] = useState<"idle" | "live" | "finished">("idle");
  const [sharing, setSharing] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [holdLeft, setHoldLeft] = useState(0);
  const [invIdx, setInvIdx] = useState(0);
  const [invoice, setInvoice] = useState<Invoice>(START_INVOICE);
  const [suggestion, setSuggestion] = useState("");
  const [extracting, setExtracting] = useState(false);

  /* debrief state */
  const [gaps, setGaps] = useState<string[]>([]);
  const [gapIdx, setGapIdx] = useState(0);
  const [debriefAnswers, setDebriefAnswers] = useState<{ q: string; a: string }[]>([]);

  /* train state */
  const [cases, setCases] = useState<TrainCase[]>(BASE_CASES);
  const [caseIdx, setCaseIdx] = useState(0);
  const [trainRecord, setTrainRecord] = useState<RecordValues>(BASE_CASES[0]!.record);
  const [fails, setFails] = useState<Verdict[]>([]);
  const [unknowns, setUnknowns] = useState<Verdict[]>([]);
  const [caseSaved, setCaseSaved] = useState(false);
  const [trainDone, setTrainDone] = useState(false);
  const perRule = useRef<Record<string, { failed: boolean; passed: boolean }>>({});

  /* ---------- refs ---------- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const offRef = useRef(false);
  const holdUntil = useRef(0);
  const lastActivity = useRef(now());
  const lastSpeech = useRef(0);
  const lastNudge = useRef(0);
  const lastActivityPing = useRef(0);
  const agentSpeaking = useRef(false);
  const voiceRef = useRef<Agent | null>(null);
  const modeRef = useRef<Mode>("teach");
  const pending = useRef<PendingEvent[]>([]);
  const asked = useRef<Set<string>>(new Set());
  const latestFrame = useRef<Frame | null>(null);
  const lastVisionFrame = useRef<string | undefined>(undefined);
  const frameCount = useRef(0);
  const visionBusy = useRef(false);
  const prevInvoice = useRef<Invoice>(START_INVOICE);
  const fieldTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const gapRef = useRef<{ list: string[]; idx: number }>({ list: [], idx: 0 });

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    // Load persisted maps after paint; localStorage is a per-browser convenience.
    const t = setTimeout(() => {
      const m = loadMaps();
      setMaps(m);
      const a = pickActiveMap(m);
      if (a) setNote(`Work Map v${a.version} is confirmed and active from an earlier session.`);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const log = useCallback((kind: Kind, text: string, attachFrame = true) => {
    const e: Entry = { id: nextId++, t: now(), kind, text, frameId: attachFrame ? latestFrame.current?.id : undefined };
    setEntries((xs) => [...xs, e]);
    return e;
  }, []);

  /* ---------- voice (one session at a time; two agents) ---------- */
  const conversation = useConversation({
    onConnect: () => { /* agent set in connectVoice */ },
    onDisconnect: () => { voiceRef.current = null; setVoiceAgent(null); },
    onError: (m: string) => setErr(`Voice: ${m}`),
    onModeChange: ({ mode: m }) => { agentSpeaking.current = m === "speaking"; setAgentMode(m as "listening" | "speaking"); },
    onVadScore: ({ vadScore }) => { if (vadScore > VAD_SPEAKING) lastSpeech.current = now(); },
    onMessage: ({ message, role }) => {
      if (message.startsWith("[APP SIGNAL")) return; // app signals are never speech
      if (role === "user") {
        lastSpeech.current = now();
        if (offRef.current) return;
        log("expert", message);
        if (modeRef.current === "review" && gapRef.current.list.length > 0) {
          const q = gapRef.current.list[gapRef.current.idx] ?? "(follow-up)";
          setDebriefAnswers((xs) => [...xs, { q, a: message }]);
        }
      } else {
        log("agent", message);
      }
    },
  });
  const convRef = useRef(conversation);
  useEffect(() => { convRef.current = conversation; }, [conversation]);

  const connectVoice = useCallback(async (agent: Agent) => {
    setErr("");
    try {
      if (voiceRef.current) { convRef.current.endSession(); voiceRef.current = null; setVoiceAgent(null); }
      const r = await fetch(`/api/signed-url?agent=${agent}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      convRef.current.startSession({ signedUrl: j.signedUrl, connectionType: "websocket" });
      voiceRef.current = agent;
      setVoiceAgent(agent);
      return true;
    } catch (e) {
      setNote(`Voice not connected (${String(e instanceof Error ? e.message : e)}). Everything still works — spoken parts show as text.`);
      return false;
    }
  }, []);

  /* ---------- teach: capture plumbing (same engine as the verified gate) ---------- */
  const screenEvent = useCallback((kind: "app" | "vision", text: string, topic: string) => {
    if (offRef.current || modeRef.current !== "teach") return;
    log(kind, text);
    pending.current.push({ topic, text: `[${kind}] ${text}` });
    if (voiceRef.current === "interviewer") {
      convRef.current.sendContextualUpdate(`[SCREEN · ${kind} @ ${clock(now())}] ${text}`);
    }
  }, [log]);

  useEffect(() => {
    const onAct = () => {
      lastActivity.current = now();
      if (voiceRef.current && !offRef.current && now() - lastActivityPing.current > 500) {
        convRef.current.sendUserActivity();
        lastActivityPing.current = now();
      }
    };
    const evs = ["keydown", "mousedown", "mousemove", "wheel", "input"] as const;
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, onAct));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShot(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* pause detector → one short why-question (teach only) */
  useEffect(() => {
    const iv = setInterval(() => {
      const t = now();
      setHoldLeft(Math.max(0, holdUntil.current - t));
      if (modeRef.current !== "teach" || phase !== "live") return;
      const d = decideNudge({
        now: t, connected: true, offRecord: offRef.current, holdUntil: holdUntil.current,
        lastActivity: lastActivity.current, lastSpeech: lastSpeech.current,
        agentSpeaking: agentSpeaking.current, lastNudge: lastNudge.current,
        pauseMs: 2500, speechQuietMs: SPEECH_QUIET_MS, cooldownMs: 20000,
        pending: pending.current, askedTopics: asked.current,
      });
      if (d.action === "wait") return;
      if (d.action === "drop-asked") { pending.current = []; log("signal", "Topic already asked — repeated events dropped", false); return; }
      pending.current = [];
      d.events.forEach((e) => asked.current.add(e.topic));
      lastNudge.current = t;
      if (voiceRef.current === "interviewer") {
        convRef.current.sendUserMessage(buildNudgeMessage(d.events, t - lastActivity.current));
        log("signal", `Pause detected — asked the interviewer to consider ${d.events.length} event(s)`, false);
      } else {
        setSuggestion(`Would ask about: ${d.events[0]!.text}`);
        log("signal", "Pause detected (voice off) — suggestion shown, not spoken", false);
      }
    }, 400);
    return () => clearInterval(iv);
  }, [phase, log]);

  /* frames + vision */
  useEffect(() => {
    if (!sharing || phase !== "live") return;
    const iv = setInterval(async () => {
      if (offRef.current) return;
      const v = videoRef.current, cv = canvasRef.current;
      if (!v || !cv || !v.videoWidth) return;
      const W = 960, H = Math.round((v.videoHeight / v.videoWidth) * W);
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(v, 0, 0, W, H);
      const sx = W / window.innerWidth, sy = H / window.innerHeight;
      document.querySelectorAll<HTMLElement>("[data-redact]").forEach((el) => {
        const r = el.getBoundingClientRect();
        ctx.fillStyle = "#000";
        ctx.fillRect(r.left * sx - 4, r.top * sy - 4, r.width * sx + 8, r.height * sy + 8);
      });
      const url = cv.toDataURL("image/jpeg", 0.6);
      const f: Frame = { id: nextId++, t: now(), url };
      latestFrame.current = f;
      setFrames((fs) => [...fs.slice(-200), f]);
      frameCount.current++;
      if (frameCount.current % VISION_EVERY !== 0 || visionBusy.current) return;
      visionBusy.current = true;
      try {
        const r = await fetch("/api/vision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prev: lastVisionFrame.current, curr: url }),
        });
        const j = await r.json();
        lastVisionFrame.current = url;
        if (!j.error && j.text && !j.text.includes("NO_CHANGE") && !offRef.current) {
          screenEvent("vision", j.text, visionTopic(j.text));
        }
      } finally {
        visionBusy.current = false;
      }
    }, FRAME_MS);
    return () => clearInterval(iv);
  }, [sharing, phase, screenEvent]);

  const startSession = async () => {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 }, audio: false,
        // @ts-expect-error Chrome-only hints
        preferCurrentTab: true, selfBrowserSurface: "include",
      });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      stream.getVideoTracks()[0]!.onended = () => { setSharing(false); setNote("Screen sharing ended — evidence is safe. Share this tab again to continue."); };
      setSharing(true);
      setPhase("live");
      log("system", "Recording started.", false);
      await connectVoice("interviewer");
    } catch (e) {
      setErr(e instanceof Error && e.name === "NotAllowedError" ? "Screen sharing was declined — click Start session again and pick this tab." : String(e));
    }
  };

  const toggleOff = () => {
    const next = !offRef.current;
    offRef.current = next;
    setOffRecord(next);
    convRef.current.setMuted(next);
    if (next) pending.current = [];
    log("system", next ? "Off the record — mic muted, no frames, no events sent." : "Back on the record.", false);
  };

  const toggleHold = () => {
    const holding = holdUntil.current > now();
    holdUntil.current = holding ? 0 : now() + HOLD_MS;
    log("system", holding ? "Moment over — questions allowed again." : "Give me a moment — still recording, questions held.", false);
  };

  const editField = (field: keyof Invoice, uiLabel: string) => (val: string) => {
    setInvoice((inv) => ({ ...inv, [field]: val }));
    clearTimeout(fieldTimers.current[field]);
    fieldTimers.current[field] = setTimeout(() => {
      const before = prevInvoice.current[field];
      if (before === val) return;
      prevInvoice.current = { ...prevInvoice.current, [field]: val };
      screenEvent("app", `${uiLabel} changed "${before}" → "${val}" on ${invoice.id} (${invoice.vendor}, €${invoice.amount})`, appTopic(invoice.id, uiLabel));
    }, 900);
  };

  const saveInvoice = () => {
    screenEvent("app", `Save clicked on ${invoice.id}: category="${invoice.category}", cost center=${invoice.costCenter}`, appTopic(invoice.id, "save"));
    if (invIdx < TEACH_QUEUE.length - 1) {
      const n = invIdx + 1;
      setInvIdx(n);
      const q = TEACH_QUEUE[n]!;
      const nextInv: Invoice = { id: q.id, vendor: q.vendor, amount: q.amount, category: "Operating expense", costCenter: "4711", iban: START_INVOICE.iban };
      prevInvoice.current = nextInv;
      setInvoice(nextInv);
      screenEvent("app", `Opened ${q.id} (${q.vendor}, €${q.amount})`, appTopic(q.id, "open"));
    }
  };

  /* ---------- finish → draft → review (+ spoken debrief) ---------- */
  const finishTeach = async () => {
    setPhase("finished");
    setExtracting(true);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setSharing(false);
    let d: WorkMap | null = null;
    try {
      const r = await fetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: entries.map(({ kind, text, t, frameId }) => ({ kind, text, t, frameId })), expert: "Sabine" }),
      });
      const j = await r.json();
      if (r.ok && j.draft) {
        d = { workMap: "invoice-processing", version: 0, supersedes: null, expert: "Sabine", steps: [], rules: [], openQuestions: [], ...j.draft, confirmed: false };
      } else {
        setNote(`Draft built without AI (${j.error ?? "no key"}). Sabine's spoken answers are kept below — turn them into rules in one click each.`);
      }
    } catch { /* fall through to manual */ }
    d ??= manualDraft(entries.map(({ kind, text, t, frameId }) => ({ kind: kind as "app" | "vision" | "expert" | "agent", text, t, frameId })), "Sabine");
    const { map: clamped, downgraded } = clampToVocabulary(d);
    if (downgraded.length) setNote(`${downgraded.length} proposed rule(s) used unknown fields and became open questions instead.`);
    setExtracting(false);
    setDraft(clamped);
    const g = gapQuestions(clamped);
    setGaps(g);
    setGapIdx(0);
    gapRef.current = { list: g, idx: 0 };
    setMode("review");
    if (voiceRef.current === "interviewer" && g.length) {
      askGap(g, 0);
    }
  };

  const askGap = (list: string[], idx: number) => {
    const q = list[idx];
    if (!q || voiceRef.current !== "interviewer") return;
    convRef.current.sendUserMessage(
      `[APP SIGNAL — DEBRIEF, not the expert speaking] Ask the expert exactly this question, word for word, then wait for the answer: «${q}»`,
    );
    log("signal", `Debrief question ${idx + 1}/${list.length} sent to the interviewer`, false);
  };

  const nextGap = () => {
    const n = Math.min(gapIdx + 1, gaps.length);
    setGapIdx(n);
    gapRef.current.idx = n;
    if (n < gaps.length) askGap(gaps, n);
  };

  const teachBack = () => {
    if (voiceRef.current !== "interviewer") return;
    convRef.current.sendUserMessage(
      `[APP SIGNAL — TEACH-BACK, not the expert speaking] In under 60 seconds, explain the whole invoice process back in your own words — steps, the rules you learned with their limits, and when to stop and ask someone. End by asking: "Is that how it works?"`,
    );
    log("signal", "Teach-back requested", false);
  };

  const confirmMap = () => {
    if (!draft) return;
    const confirmed: Omit<WorkMap, "version" | "supersedes"> = { ...draft, confirmed: true };
    const nextMaps = addVersion(maps, confirmed);
    setMaps(nextMaps);
    saveMaps(nextMaps);
    setDraft(null);
    if (voiceRef.current === "interviewer") { convRef.current.endSession(); }
    const v = nextMaps[nextMaps.length - 1]!.version;
    setNote(`Work Map v${v} confirmed. ${activeRules(nextMaps[nextMaps.length - 1]!).length} rule(s) are now live for training.`);
    setMode("train");
    resetTrain(BASE_CASES, 0);
  };

  /* ---------- train ---------- */
  const active = pickActiveMap(maps);
  const rules = useMemo(() => activeRules(active), [active]);

  function resetTrain(cs: TrainCase[], idx: number) {
    setCases(cs);
    setCaseIdx(idx);
    setTrainRecord(cs[idx]!.record);
    setFails([]); setUnknowns([]); setCaseSaved(false); setTrainDone(false);
    perRule.current = {};
  }

  const trySave = () => {
    const verdicts = evaluate(rules, trainRecord);
    const failing = verdicts.filter((v) => v.outcome === "fail");
    const unk = verdicts.filter((v) => v.outcome === "unknown-field");
    for (const v of verdicts) {
      const s = (perRule.current[v.ruleId] ??= { failed: false, passed: false });
      if (v.outcome === "fail") s.failed = true;
      if (v.outcome === "pass") s.passed = true;
    }
    setUnknowns(unk);
    if (failing.length) {
      setFails(failing);
      const r = rules.find((x) => x.id === failing[0]!.ruleId)!;
      if (voiceRef.current === "tutor") {
        convRef.current.sendUserMessage(
          `[APP SIGNAL — RULE ${r.id} FAILED, not the learner speaking] The save was blocked. Sabine's rule: ${describeRule(r)} Her words: "${r.evidence.quote}". Ask briefly why she would stop here, then tell them to fix it and save again. Under 30 words.`,
        );
      }
      return;
    }
    setFails([]);
    setCaseSaved(true);
    if (voiceRef.current === "tutor" && cases[caseIdx]!.hints) {
      convRef.current.sendUserMessage(`[APP SIGNAL — SAVE OK, not the learner speaking] The save passed every rule. One short line of praise, nothing more.`);
    }
  };

  const nextCase = () => {
    if (caseIdx < cases.length - 1) {
      const n = caseIdx + 1;
      setCaseIdx(n);
      setTrainRecord(cases[n]!.record);
      setFails([]); setUnknowns([]); setCaseSaved(false);
    } else {
      setTrainDone(true);
      if (voiceRef.current === "tutor") convRef.current.endSession();
    }
  };

  const thresholdProof = () => {
    if (!active) return;
    const idx = active.rules.findIndex((r) => r.when.some((c) => c.op === "gt" && c.field === "amount"));
    if (idx === -1) { setErr("No amount threshold rule exists to update."); return; }
    const updated: Rule = {
      ...active.rules[idx]!,
      when: active.rules[idx]!.when.map((c) => (c.op === "gt" && c.field === "amount" ? { ...c, value: 4000 } : c)),
      evidence: { quote: "Actually, it's 4,000 now.", source: "correction", t: clock(now()), frameId: null },
      status: "confirmed",
    };
    const v2rules = active.rules.map((r, i) => (i === idx ? updated : r));
    const nextMaps = addVersion(maps, { ...active, rules: v2rules, confirmed: true });
    setMaps(nextMaps);
    saveMaps(nextMaps);
    const v = nextMaps[nextMaps.length - 1]!.version;
    setNote(`Sabine changed the threshold. Work Map v${v} is active; v${v - 1} is superseded — both are never active. No code changed.`);
    const cs = cases.some((c) => c.id === PROOF_CASE.id) ? cases : [...cases, PROOF_CASE];
    resetTrain(cs, cs.findIndex((c) => c.id === PROOF_CASE.id));
  };

  const exportMap = () => {
    if (!active) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(active, null, 2)], { type: "application/json" }));
    a.download = `work-map-v${active.version}.json`;
    a.click();
  };

  const exportSession = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ entries, stats: undefined }, null, 1)], { type: "application/json" }));
    a.download = `understudy-session-${Date.now()}.json`;
    a.click();
  };

  /* ---------- derived ---------- */
  const frameById = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames]);
  const transcript = useMemo(() => entries.filter((e) => e.kind === "expert" || e.kind === "agent"), [entries]);
  const lastAgent = [...transcript].reverse().find((e) => e.kind === "agent")?.text;
  const lastExpert = [...transcript].reverse().find((e) => e.kind === "expert")?.text;
  const reviewMap = draft ?? active;
  const counters = useMemo(() => {
    const qs = reviewMap?.openQuestions ?? [];
    return {
      answered: qs.filter((q) => q.status === "answered").length + debriefAnswers.length,
      deferred: qs.filter((q) => q.status === "deferred").length,
      unresolved: qs.filter((q) => q.status === "unresolved").length,
    };
  }, [reviewMap, debriefAnswers]);
  const holding = holdLeft > 0;
  const orbState = !voiceAgent || offRecord ? "off" : agentMode === "speaking" ? "speaking" : "listening";

  const stepperItems: { key: Mode; label: string; enabled: boolean }[] = [
    { key: "teach", label: "1 · Teach Understudy", enabled: true },
    { key: "review", label: "2 · Review what it learned", enabled: Boolean(draft || maps.length) },
    { key: "train", label: "3 · Train a teammate", enabled: Boolean(active) },
  ];

  return (
    <div className="wrap">
      <header className="topbar">
        <span className="brand"><span className="dot" aria-hidden />Understudy</span>
        <nav className="stepper" aria-label="Modes">
          {stepperItems.map((s) => (
            <button key={s.key} className={`step ${mode === s.key ? "now" : ""}`} disabled={!s.enabled}
              onClick={() => setMode(s.key)}>{s.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        {(sharing || voiceAgent) && (
          <span className={`rec ${offRecord ? "paused" : ""}`}><span className="reddot" aria-hidden />{offRecord ? "Paused" : "Recording"}</span>
        )}
        <span className={`pill ${voiceAgent ? "ok" : ""}`}>voice {voiceAgent ?? "off"}</span>
      </header>

      {note && <div className="banner" role="status">{note}<button className="x" aria-label="Dismiss" onClick={() => setNote("")}>×</button></div>}
      {err && <div className="banner errb" role="alert">{err}<button className="x" aria-label="Dismiss" onClick={() => setErr("")}>×</button></div>}
      {suggestion && mode === "teach" && <div className="banner" role="status">{suggestion}<button className="x" aria-label="Dismiss" onClick={() => setSuggestion("")}>×</button></div>}

      {/* ================= TEACH ================= */}
      {mode === "teach" && (
        <main className="main">
          <section className="u-card panel">
            <span className="sandboxTag">Sandbox — fictional company and invoices</span>
            <h2>Invoice {invoice.id} <small style={{ color: "var(--mute)" }}>({invIdx + 1} of {TEACH_QUEUE.length})</small></h2>
            <div className="form">
              <label>Vendor</label><div>{invoice.vendor}</div>
              <label htmlFor="f-amount">Amount (€)</label>
              <input id="f-amount" value={invoice.amount} onChange={(e) => editField("amount", "Amount")(e.target.value)} />
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" value={invoice.category} onChange={(e) => editField("category", "Category")(e.target.value)}>
                <option>Operating expense</option><option>Capital expenditure</option><option>Intercompany</option>
              </select>
              <label htmlFor="f-cc">Cost center</label>
              <input id="f-cc" value={invoice.costCenter} onChange={(e) => editField("costCenter", "Cost center")(e.target.value)} />
              <label>Vendor IBAN</label>
              <div className="ro"><span className="iban" data-redact>{invoice.iban}</span></div>
            </div>
            <div className="saveRow">
              <button className="btn" onClick={saveInvoice} disabled={phase !== "live"}>Save invoice</button>
              {phase === "idle" && <button className="btn primary" onClick={startSession}>Start session</button>}
              {phase === "live" && (
                <>
                  <button className={`btn ${holding ? "holding" : ""}`} onClick={toggleHold}>{holding ? `I'm ready (${Math.ceil(holdLeft / 1000)}s)` : "Give me a moment"}</button>
                  <button className="switch" aria-pressed={offRecord} onClick={toggleOff}>
                    <span className="track" aria-hidden><span className="knob" /></span>Off the record
                  </button>
                  <button className="btn primary" onClick={finishTeach} disabled={extracting}>{extracting ? "Building the Work Map…" : "Finish"}</button>
                </>
              )}
            </div>
            <div className="moments">
              <h4>Captured moments</h4>
              <div className="momentRow">
                {entries.filter((e) => e.frameId && (e.kind === "app" || e.kind === "vision" || e.kind === "expert") && frameById.has(e.frameId)).map((m) => (
                  <button key={m.id} className="moment" onClick={() => setShot({ frameId: m.frameId!, text: m.text, t: clock(m.t) })}>
                    <img src={frameById.get(m.frameId!)!.url} alt={`Screen at ${clock(m.t)}`} />
                    <span className="mlabel">{clock(m.t)} · {m.kind === "expert" ? "answer" : m.text}</span>
                  </button>
                ))}
                {frames.length === 0 && <span className="none">Moments appear here as Understudy watches you work.</span>}
              </div>
            </div>
          </section>

          <aside className="u-card panel companion">
            <div className="orbWrap"><div className={`orb ${orbState}`} aria-hidden /><div className="orbLabel" aria-live="polite">{!voiceAgent ? "Voice off — suggestions shown" : offRecord ? "Off the record" : agentMode === "speaking" ? "Speaking" : "Listening"}</div></div>
            <div className="caption" aria-live="polite">{lastAgent ?? (phase === "live" ? "Just work normally. I'll only ask when you pause." : "Click Start session, then share this tab.")}</div>
            {lastExpert && <div className="caption expertCap">“{lastExpert}”</div>}
            <TypedTurn enabled={voiceAgent === "interviewer"} placeholder="No voice today? Type Sabine's answer…"
              onSend={(t) => convRef.current.sendUserMessage(t)} />
            <div className="transcript">
              {transcript.map((e) => (
                <div key={e.id} className={`line ${e.kind}`}>
                  <span className="who">{e.kind === "agent" ? "Understudy" : "Expert"}</span>
                  <span>{e.text}</span>
                  {e.frameId && frameById.has(e.frameId) && (
                    <button className="cam" title="See the screen moment" onClick={() => setShot({ frameId: e.frameId!, text: e.text, t: clock(e.t) })}>📷</button>
                  )}
                </div>
              ))}
            </div>
          </aside>
        </main>
      )}

      {/* ================= REVIEW ================= */}
      {mode === "review" && (
        <ReviewMode
          map={draft ?? active}
          editable={Boolean(draft)}
          counters={counters}
          gaps={gaps}
          gapIdx={gapIdx}
          debriefAnswers={debriefAnswers}
          voiceOn={voiceAgent === "interviewer"}
          frames={frameById}
          onAskGap={() => askGap(gaps, gapIdx)}
          onNextGap={nextGap}
          onTeachBack={teachBack}
          onConnectVoice={() => connectVoice("interviewer")}
          onTypedAnswer={(t) => convRef.current.sendUserMessage(t)}
          onShot={(frameId, text, t) => setShot({ frameId, text, t })}
          onChange={(m) => setDraft(m)}
          onConfirm={confirmMap}
        />
      )}

      {/* ================= TRAIN ================= */}
      {mode === "train" && active && (
        <TrainMode
          map={active}
          rules={rules}
          cases={cases}
          caseIdx={caseIdx}
          record={trainRecord}
          fails={fails}
          unknowns={unknowns}
          saved={caseSaved}
          done={trainDone}
          perRule={perRule.current}
          voiceOn={voiceAgent === "tutor"}
          frames={frameById}
          lastAgent={lastAgent}
          onConnectVoice={() => connectVoice("tutor")}
          onTypedAnswer={(t) => convRef.current.sendUserMessage(t)}
          onRecord={(r) => { setTrainRecord(r); setFails([]); }}
          onSave={trySave}
          onNext={nextCase}
          onProof={thresholdProof}
          onExport={exportMap}
          onShot={(frameId, text, t) => setShot({ frameId, text, t })}
          onRestart={() => resetTrain(cases, 0)}
        />
      )}

      <footer style={{ display: "flex", gap: 10, padding: "10px 2px", color: "var(--mute)", fontSize: 12.5 }}>
        <span>Sandbox — fictional company and invoices.</span>
        <span className="spacer" />
        <button className="btn subtle" onClick={exportSession}>Export session JSON</button>
      </footer>

      {shot && frameById.has(shot.frameId) && (
        <div className="overlay" onClick={() => setShot(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Captured screen moment">
            <div className="mhead"><span className="k">Screen moment</span><time>{shot.t}</time>
              <button className="x" aria-label="Close" onClick={() => setShot(null)}>×</button></div>
            <img src={frameById.get(shot.frameId)!.url} alt={`Redacted screen capture at ${shot.t}`} />
            <p className="q">{shot.text}</p>
          </div>
        </div>
      )}

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}

/* ============================================================= REVIEW */

function ReviewMode(props: {
  map: WorkMap | null;
  editable: boolean;
  counters: { answered: number; deferred: number; unresolved: number };
  gaps: string[];
  gapIdx: number;
  debriefAnswers: { q: string; a: string }[];
  voiceOn: boolean;
  frames: Map<number, Frame>;
  onAskGap: () => void;
  onNextGap: () => void;
  onTeachBack: () => void;
  onConnectVoice: () => void;
  onTypedAnswer: (t: string) => void;
  onShot: (frameId: number, text: string, t: string) => void;
  onChange: (m: WorkMap) => void;
  onConfirm: () => void;
}) {
  const { map, editable } = props;
  const [form, setForm] = useState({ scopeItem: "equipment", condField: "amount", condOp: "gt", condValue: "5000", mode: "require", reqField: "account", reqValue: "0400 Capex", block: "", escalation: "", quote: "" });
  if (!map) return <div className="u-card panel"><p>No Work Map yet — record a Teach session first.</p></div>;

  const setRuleStatus = (i: number, status: Rule["status"]) =>
    props.onChange({ ...map, rules: map.rules.map((r, j) => (j === i ? { ...r, status } : r)) });
  const removeRule = (i: number) =>
    props.onChange({
      ...map,
      rules: map.rules.filter((_, j) => j !== i),
      openQuestions: [...map.openQuestions, { q: `Removed rule ${map.rules[i]!.id} ("${map.rules[i]!.block}") — restate it with Sabine if it matters.`, status: "unresolved", deferredTo: null }],
    });
  const setQuestion = (i: number, status: "answered" | "deferred" | "unresolved", deferredTo: string | null) =>
    props.onChange({ ...map, openQuestions: map.openQuestions.map((q, j) => (j === i ? { ...q, status, deferredTo } : q)) });

  const addRule = () => {
    const id = `R${map.rules.length + 1}`;
    const value = form.condField === "amount" ? Number(form.condValue) : form.condValue;
    const rule: Rule = {
      id,
      scope: form.scopeItem ? { itemType: form.scopeItem } : {},
      when: [{ field: form.condField, op: form.condOp as Rule["when"][number]["op"], value }],
      require: form.mode === "require" ? { field: form.reqField, value: form.reqValue } : null,
      block: form.block || (form.mode === "require" ? `${form.reqField} must be ${form.reqValue}.` : "Stop here."),
      escalation: form.escalation || null,
      evidence: { quote: form.quote || "(added by the expert in review)", source: "debrief", t: clock(now()), frameId: null },
      status: "confirmed",
    };
    const { map: clamped, downgraded } = clampToVocabulary({ ...map, rules: [...map.rules, rule] });
    props.onChange(clamped);
    if (!downgraded.length) setForm((f) => ({ ...f, block: "", quote: "" }));
  };

  const confirmedCount = map.rules.filter((r) => r.status === "confirmed").length;

  return (
    <main className="main">
      <section className="u-card panel">
        <h2>What Understudy learned {map.version ? `— version ${map.version}` : "(draft)"}</h2>
        <p style={{ color: "var(--mute)", fontSize: 13.5, marginTop: -6 }}>
          Drafts are never policy. Check each rule against Sabine&apos;s own words, fix or remove what&apos;s wrong, then Confirm.
        </p>
        <div style={{ display: "flex", gap: 8, margin: "6px 0 14px" }}>
          <span className="pill ok">answered {props.counters.answered}</span>
          <span className="pill">deferred {props.counters.deferred}</span>
          <span className="pill warn">unresolved {props.counters.unresolved}</span>
        </div>

        <h3>Steps</h3>
        <div className="cards">
          {map.steps.length === 0 && <p style={{ color: "var(--mute)" }}>No steps captured.</p>}
          {map.steps.map((s) => (
            <div key={s.n} className="u-card step">
              {s.frameId && props.frames.has(s.frameId)
                ? <img src={props.frames.get(s.frameId)!.url} alt="" onClick={() => props.onShot(s.frameId!, s.decision, s.t)} style={{ cursor: "zoom-in" }} />
                : <div className="noframe">no frame</div>}
              <div>
                <h4>{s.n}. {s.title}</h4>
                <div className="meta">{s.decision}</div>
                <div className="meta">{s.t} · rules: {s.ruleIds.join(", ") || "—"}</div>
              </div>
            </div>
          ))}
        </div>

        <h3 style={{ marginTop: 16 }}>Still unanswered</h3>
        {map.openQuestions.map((q, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6, fontSize: 14 }}>
            <span className={`pill ${q.status === "answered" ? "ok" : q.status === "unresolved" ? "warn" : ""}`}>{q.status}</span>
            <span style={{ flex: 1 }}>{q.q}{q.deferredTo ? ` → ${q.deferredTo}` : ""}</span>
            {editable && (
              <select value={q.status} onChange={(e) => {
                const st = e.target.value as "answered" | "deferred" | "unresolved";
                const to = st === "deferred" ? (prompt("Deferred to whom? (e.g. the controller)") || "a colleague") : null;
                setQuestion(i, st, to);
              }}>
                <option value="unresolved">unresolved</option>
                <option value="deferred">deferred</option>
                <option value="answered">answered</option>
              </select>
            )}
          </div>
        ))}

        {editable && (
          <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center" }}>
            <button className="btn primary" onClick={props.onConfirm} disabled={confirmedCount === 0}
              title={confirmedCount === 0 ? "Confirm at least one rule first (or add one)" : "Makes these rules live for training"}>
              Confirm map — {confirmedCount} rule{confirmedCount === 1 ? "" : "s"} go live
            </button>
            <span style={{ color: "var(--mute)", fontSize: 13 }}>Say “Yes, that’s how it works” — or click.</span>
          </div>
        )}
      </section>

      <aside className="u-card panel">
        <h3>Spoken debrief</h3>
        {!props.voiceOn && <button className="btn" onClick={props.onConnectVoice}>Connect voice for the debrief</button>}
        {props.gaps.length > 0 && (
          <ol style={{ paddingLeft: 18, fontSize: 14, lineHeight: 1.6 }}>
            {props.gaps.map((g, i) => (
              <li key={i} style={{ color: i < props.gapIdx ? "var(--ok)" : i === props.gapIdx ? "var(--ink)" : "var(--mute)" }}>{g}</li>
            ))}
          </ol>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {props.voiceOn && props.gapIdx < props.gaps.length && <button className="btn" onClick={props.onAskGap}>Ask question {props.gapIdx + 1} by voice</button>}
          {props.gapIdx < props.gaps.length && <button className="btn subtle" onClick={props.onNextGap}>Next question</button>}
          {props.voiceOn && <button className="btn" onClick={props.onTeachBack}>Teach-back (≈60s)</button>}
        </div>
        <TypedTurn enabled={props.voiceOn} placeholder="Type Sabine's answer to the question…" onSend={props.onTypedAnswer} />
        {props.debriefAnswers.length > 0 && (
          <>
            <h4 style={{ margin: "12px 0 6px" }}>Answers captured</h4>
            {props.debriefAnswers.map((a, i) => <p key={i} style={{ fontSize: 13.5, margin: "4px 0" }}><em>“{a.a}”</em></p>)}
          </>
        )}

        <h3 style={{ marginTop: 16 }}>The rules ({map.rules.length})</h3>
        <div className="cards">
          {map.rules.map((r, i) => (
            <div key={r.id} className="u-card rule">
              <div className="head">
                <strong>{r.id}</strong>
                <span className={`pill ${r.status === "confirmed" ? "ok" : "warn"}`}>{r.status === "confirmed" ? "checked by expert" : r.status === "corrected" ? "edited" : "unchecked"}</span>
                {editable && r.status !== "confirmed" && <button className="btn subtle" onClick={() => setRuleStatus(i, "confirmed")}>Yes, that’s right</button>}
                {editable && <button className="btn subtle" onClick={() => removeRule(i)}>That’s wrong — remove</button>}
              </div>
              <div style={{ fontSize: 14 }}>{describeRule(r)}</div>
              <blockquote>“{r.evidence.quote}” <span style={{ fontStyle: "normal", color: "var(--mute)" }}>— {r.evidence.source}, {r.evidence.t}</span></blockquote>
              {r.evidence.frameId && props.frames.has(r.evidence.frameId) && (
                <img src={props.frames.get(r.evidence.frameId)!.url} alt="" onClick={() => props.onShot(r.evidence.frameId!, r.evidence.quote, r.evidence.t)} style={{ cursor: "zoom-in" }} />
              )}
            </div>
          ))}
        </div>

        {editable && (
          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 14 }}>Add a rule from Sabine’s words</summary>
            <div className="form" style={{ marginTop: 10, gridTemplateColumns: "110px 1fr" }}>
              <label>Applies to</label>
              <select value={form.scopeItem} onChange={(e) => setForm({ ...form, scopeItem: e.target.value })}>
                <option value="equipment">equipment</option><option value="service">service</option><option value="">any item</option>
              </select>
              <label>When</label>
              <div style={{ display: "flex", gap: 6 }}>
                <select value={form.condField} onChange={(e) => setForm({ ...form, condField: e.target.value })}>
                  {FIELD_VOCABULARY.map((f) => <option key={f}>{f}</option>)}
                </select>
                <select value={form.condOp} onChange={(e) => setForm({ ...form, condOp: e.target.value })}>
                  <option value="gt">over</option><option value="lt">under</option><option value="eq">is</option><option value="missing">is empty</option>
                </select>
                {form.condOp !== "missing" && <input style={{ width: 110 }} value={form.condValue} onChange={(e) => setForm({ ...form, condValue: e.target.value })} />}
              </div>
              <label>Then</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
                  <option value="require">a field must be…</option><option value="block">just stop (guardrail)</option>
                </select>
                {form.mode === "require" && (
                  <>
                    <select value={form.reqField} onChange={(e) => setForm({ ...form, reqField: e.target.value })}>
                      {FIELD_VOCABULARY.map((f) => <option key={f}>{f}</option>)}
                    </select>
                    <input style={{ width: 130 }} value={form.reqValue} onChange={(e) => setForm({ ...form, reqValue: e.target.value })} />
                  </>
                )}
              </div>
              <label>Shown when it blocks</label>
              <input placeholder='e.g. "No asset number, no capex booking."' value={form.block} onChange={(e) => setForm({ ...form, block: e.target.value })} />
              <label>Who to ask</label>
              <input placeholder="e.g. Ask the controller (optional)" value={form.escalation} onChange={(e) => setForm({ ...form, escalation: e.target.value })} />
              <label>Sabine’s words</label>
              <input placeholder="paste the sentence she said" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} />
            </div>
            <button className="btn" style={{ marginTop: 8 }} onClick={addRule}>Add rule (confirmed)</button>
          </details>
        )}
      </aside>
    </main>
  );
}

/* ============================================================= TRAIN */

function TrainMode(props: {
  map: WorkMap;
  rules: Rule[];
  cases: TrainCase[];
  caseIdx: number;
  record: RecordValues;
  fails: Verdict[];
  unknowns: Verdict[];
  saved: boolean;
  done: boolean;
  perRule: Record<string, { failed: boolean; passed: boolean }>;
  voiceOn: boolean;
  frames: Map<number, Frame>;
  lastAgent?: string;
  onConnectVoice: () => void;
  onTypedAnswer: (t: string) => void;
  onRecord: (r: RecordValues) => void;
  onSave: () => void;
  onNext: () => void;
  onProof: () => void;
  onExport: () => void;
  onShot: (frameId: number, text: string, t: string) => void;
  onRestart: () => void;
}) {
  const c = props.cases[props.caseIdx]!;
  const r = props.record;
  const set = (field: string, value: string | number | null) => props.onRecord({ ...r, [field]: value });
  const ruleById = (id: string) => props.rules.find((x) => x.id === id)!;

  if (props.done) {
    return (
      <main className="main">
        <section className="u-card panel" style={{ maxWidth: 640 }}>
          <h2>Mastery card — trained on Work Map v{props.map.version}</h2>
          {props.rules.map((rule) => {
            const s = props.perRule[rule.id] ?? { failed: false, passed: false };
            const label = s.passed && !s.failed ? "Correct independently on this case" : s.passed ? "Correct with help" : "Practice next";
            return (
              <div key={rule.id} style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 8 }}>
                <span className={`pill ${s.passed && !s.failed ? "ok" : s.passed ? "" : "warn"}`}>{label}</span>
                <span><strong>{rule.id}</strong> — {rule.block}</span>
              </div>
            );
          })}
          <p style={{ color: "var(--mute)", fontSize: 13 }}>One case shows a result, not mastery.</p>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn" onClick={props.onRestart}>Run the cases again</button>
            <button className="btn" onClick={props.onProof}>Threshold proof (Sabine: “it’s 4,000 now”)</button>
            <button className="btn subtle" onClick={props.onExport}>Export Work Map JSON</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="main">
      <section className="u-card panel">
        <span className="sandboxTag">Sandbox — fictional company and invoices</span>
        <h2>{c.note}</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <span className="pill">invoice {props.caseIdx + 1} of {props.cases.length}</span>
          <span className="pill">Trained on Work Map v{props.map.version}</span>
          {!c.hints && <span className="pill">hints off</span>}
        </div>
        <div className="form">
          <label>Vendor</label><div>{c.vendor}</div>
          <label>Amount (€)</label><div>{Number(r.amount).toLocaleString("en-IE")}</div>
          <label>Item type</label><div>{r.itemType == null ? "— (not on the document)" : String(r.itemType)}</div>
          <label>Month</label><div>{String(r.month)}</div>
          <label htmlFor="t-account">Account</label>
          <select id="t-account" value={String(r.account)} onChange={(e) => set("account", e.target.value)}>
            <option>4711 Opex</option><option>0400 Capex</option><option>0450 Intercompany</option>
          </select>
          <label htmlFor="t-asset">Asset number</label>
          <input id="t-asset" value={String(r.assetNumber ?? "")} placeholder="empty" onChange={(e) => set("assetNumber", e.target.value || null)} />
          <label htmlFor="t-approval">Approval route</label>
          <select id="t-approval" value={String(r.approval)} onChange={(e) => set("approval", e.target.value)}>
            <option>Standard</option><option>Second approval</option><option>CFO approval</option>
          </select>
          <label htmlFor="t-pay">Payment status</label>
          <select id="t-pay" value={String(r.paymentStatus)} onChange={(e) => set("paymentStatus", e.target.value)}>
            <option>Scheduled</option><option>On hold</option><option>Paid</option>
          </select>
          <label>Vendor IBAN</label>
          <div className="ro"><span className="iban" data-redact>DE89 3704 0044 0532 0130 00</span></div>
        </div>
        <div className="saveRow">
          {!props.saved ? (
            <button className={`btn ${props.fails.length ? "holding" : "primary"}`} onClick={props.onSave}>
              {props.fails.length ? "Check needed — Save blocked" : "Save invoice"}
            </button>
          ) : (
            <>
              <span className="pill ok">Saved ✓</span>
              <button className="btn primary" onClick={props.onNext}>{props.caseIdx < props.cases.length - 1 ? "Next case" : "Finish — mastery card"}</button>
            </>
          )}
          <span className="spacer" />
          <button className="btn subtle" onClick={props.onProof} title="Second session: Sabine lowers the threshold; v2 supersedes v1 with no code change.">Threshold proof</button>
          <button className="btn subtle" onClick={props.onExport}>Export Work Map JSON</button>
        </div>
      </section>

      <aside style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="u-card panel" style={{ textAlign: "center" }}>
          {!props.voiceOn
            ? <button className="btn" onClick={props.onConnectVoice}>Connect tutor voice</button>
            : <>
                <div className="caption" style={{ minHeight: 40 }}>{props.lastAgent ?? "The tutor only speaks when a confirmed rule would be broken."}</div>
                <TypedTurn enabled placeholder="Type Lena's reply to the tutor…" onSend={props.onTypedAnswer} />
              </>}
        </div>
        {props.fails.map((v) => {
          const rule = ruleById(v.ruleId);
          return (
            <div key={v.ruleId} className="u-card coach" role="alert">
              <h4>Sabine would stop here — {rule.id}</h4>
              <div>{rule.block}</div>
              <blockquote>“{rule.evidence.quote}” — Sabine, {rule.evidence.t}</blockquote>
              {rule.escalation && <div className="esc">When unsure: {rule.escalation}</div>}
              {rule.evidence.frameId && props.frames.has(rule.evidence.frameId) && (
                <img src={props.frames.get(rule.evidence.frameId)!.url} alt="Sabine's screen at that moment (redacted)"
                  onClick={() => props.onShot(rule.evidence.frameId!, rule.evidence.quote, rule.evidence.t)} style={{ cursor: "zoom-in" }} />
              )}
              {c.hints && <p style={{ fontSize: 13, margin: "8px 0 0" }}>Why do you think she’d stop? Fix the field and save again.</p>}
            </div>
          );
        })}
        {props.unknowns.map((v) => (
          <div key={v.ruleId} className="banner" style={{ margin: 0 }}>{v.message} {v.escalation ? `(${v.escalation})` : ""}</div>
        ))}
        {props.fails.length === 0 && props.unknowns.length === 0 && (
          <div className="u-card panel" style={{ color: "var(--mute)", fontSize: 13.5 }}>
            Rule checks run in deterministic code on every change and on Save — never model judgment{c.hints ? "" : " (hints are off)"}.
          </div>
        )}
      </aside>
    </main>
  );
}
