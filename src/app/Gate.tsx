"use client";

import { ConversationProvider, useConversation } from "@elevenlabs/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appTopic, buildNudgeMessage, decideNudge, visionTopic, type PendingEvent } from "../lib/pauseGate";

/* ---------- tunables (change live in the Testing panel) ---------- */
const FRAME_MS = 2000; // screen frame every 2s
const VISION_EVERY = 2; // send every Nth frame to vision (=4s)
const SPEECH_QUIET_MS = 1500; // expert must be silent this long
const VAD_SPEAKING = 0.6;
const HOLD_MS = 60000; // "Give me a moment" holds questions this long

type Kind = "app" | "vision" | "signal" | "expert" | "agent" | "system";
type Entry = { id: number; t: number; kind: Kind; text: string; frameId?: number };
type Frame = { id: number; t: number; url: string };
type Invoice = { id: string; vendor: string; amount: string; category: string; costCenter: string; iban: string };

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

let nextId = 1;
const now = () => Date.now();
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });
const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);

export default function Gate() {
  return (
    <ConversationProvider>
      <GateInner />
    </ConversationProvider>
  );
}

function GateInner() {
  /* ---------- UI state ---------- */
  const [entries, setEntries] = useState<Entry[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [sharing, setSharing] = useState(false);
  const [shareEnded, setShareEnded] = useState(false);
  const [voiceDropped, setVoiceDropped] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [holdLeft, setHoldLeft] = useState(0); // ms left on "Give me a moment"
  const [invoice, setInvoice] = useState<Invoice>(START_INVOICE);
  const [pauseMs, setPauseMs] = useState(2500);
  const [cooldownMs, setCooldownMs] = useState(20000);
  const [idleFor, setIdleFor] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [toast, setToast] = useState("");
  const [stats, setStats] = useState({ ctxSent: 0, nudges: 0, suppressed: 0, answeredNudges: 0, visionHits: 0, linked: 0, topicSuppressed: 0, held: 0 });
  const [error, setError] = useState("");

  /* ---------- refs used inside timers/callbacks ---------- */
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const offRef = useRef(false);
  const holdUntil = useRef(0);
  const connectedRef = useRef(false);
  const lastActivity = useRef(now());
  const lastSpeech = useRef(0);
  const lastNudge = useRef(0);
  const lastActivityPing = useRef(0);
  const agentSpeaking = useRef(false);
  const pending = useRef<PendingEvent[]>([]);
  const askedTopics = useRef<Set<string>>(new Set());
  const latestFrame = useRef<Frame | null>(null);
  const lastVisionFrame = useRef<string | undefined>(undefined);
  const frameCount = useRef(0);
  const visionBusy = useRef(false);
  const awaitingAnswerSince = useRef(0);
  const prevInvoice = useRef<Invoice>(START_INVOICE);
  const fieldTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pauseRef = useRef(pauseMs);
  const cooldownRef = useRef(cooldownMs);
  useEffect(() => {
    pauseRef.current = pauseMs;
    cooldownRef.current = cooldownMs;
  }, [pauseMs, cooldownMs]);

  const bump = (k: keyof typeof stats, n = 1) => setStats((s) => ({ ...s, [k]: s[k] + n }));

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2500);
  }, []);

  const log = useCallback((kind: Kind, text: string, attachFrame = true) => {
    const e: Entry = { id: nextId++, t: now(), kind, text, frameId: attachFrame ? latestFrame.current?.id : undefined };
    if (e.frameId && (kind === "expert" || kind === "agent")) bump("linked");
    setEntries((xs) => [...xs, e]);
    return e;
  }, []);

  /* ---------- voice session (ElevenLabs React SDK) ---------- */
  const conversation = useConversation({
    onConnect: () => { connectedRef.current = true; setVoiceDropped(false); },
    onDisconnect: (details) => {
      connectedRef.current = false;
      if (details?.reason !== "user") setVoiceDropped(true); // evidence is kept; offer reconnect
    },
    onError: (message: string) => setError(`Voice: ${message}`),
    onModeChange: ({ mode }) => { agentSpeaking.current = mode === "speaking"; },
    onVadScore: ({ vadScore }) => {
      if (vadScore > VAD_SPEAKING) lastSpeech.current = now();
    },
    onMessage: ({ message, role }) => {
      if (message.startsWith("[APP SIGNAL")) return; // already logged as a signal, never as speech
      if (role === "user") {
        lastSpeech.current = now();
        if (!offRef.current) {
          const e = log("expert", message);
          if (e.frameId && awaitingAnswerSince.current) showToast("Reason captured");
        }
      } else {
        if (awaitingAnswerSince.current && now() - awaitingAnswerSince.current < 20000) {
          bump("answeredNudges");
        }
        awaitingAnswerSince.current = 0;
        log("agent", message);
      }
    },
  });
  const { status, startSession, endSession, setMuted } = conversation;
  const connected = status === "connected";

  const convRef = useRef(conversation);
  useEffect(() => {
    convRef.current = conversation;
    connectedRef.current = connected;
  }, [conversation, connected]);

  const startVoice = async () => {
    setError("");
    try {
      const r = await fetch("/api/signed-url");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      startSession({ signedUrl: j.signedUrl, connectionType: "websocket" });
    } catch (e) {
      setError(e instanceof Error && e.name === "NotAllowedError"
        ? "Microphone blocked. Click the mic icon in Chrome's address bar, allow it, and try again."
        : String(e instanceof Error ? e.message : e));
    }
  };

  /* ---------- screen events -> agent context ---------- */
  const screenEvent = useCallback(
    (kind: "app" | "vision", text: string, topic: string) => {
      if (offRef.current) return; // off the record: nothing recorded, nothing sent
      log(kind, text);
      pending.current.push({ topic, text: `${kind === "app" ? "[app]" : "[vision]"} ${text}` });
      if (connectedRef.current) {
        convRef.current.sendContextualUpdate(`[SCREEN · ${kind === "app" ? "app event" : "vision"} @ ${clock(now())}] ${text}`);
        bump("ctxSent");
      }
    },
    [log]
  );

  /* ---------- activity detection ---------- */
  useEffect(() => {
    const onAct = () => {
      lastActivity.current = now();
      if (connectedRef.current && !offRef.current && now() - lastActivityPing.current > 500) {
        convRef.current.sendUserActivity(); // tells the agent not to barge in
        lastActivityPing.current = now();
      }
    };
    const evs = ["keydown", "mousedown", "mousemove", "wheel", "input"] as const;
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, onAct));
  }, []);

  /* ---------- keyboard: Shift+T testing panel, Esc closes ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        return;
      }
      if (e.key === "T" && e.shiftKey && !isEditable(e.target)) setShowTest((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---------- pause detector -> nudge (logic in src/lib/pauseGate.ts) ---------- */
  useEffect(() => {
    const iv = setInterval(() => {
      const t = now();
      const idle = t - lastActivity.current;
      setIdleFor(idle);
      setHoldLeft(Math.max(0, holdUntil.current - t));
      setThinking(awaitingAnswerSince.current > 0 && t - awaitingAnswerSince.current < 15000 && !agentSpeaking.current);
      const d = decideNudge({
        now: t,
        connected: connectedRef.current,
        offRecord: offRef.current,
        holdUntil: holdUntil.current,
        lastActivity: lastActivity.current,
        lastSpeech: lastSpeech.current,
        agentSpeaking: agentSpeaking.current,
        lastNudge: lastNudge.current,
        pauseMs: pauseRef.current,
        speechQuietMs: SPEECH_QUIET_MS,
        cooldownMs: cooldownRef.current,
        pending: pending.current,
        askedTopics: askedTopics.current,
      });
      if (d.action === "wait") {
        // count events we *held back* because the expert was busy (proves no interruption)
        if (d.reason === "active" && idle < 300 && t - lastNudge.current >= cooldownRef.current) bump("suppressed");
        if (d.reason === "holding") bump("held");
        return;
      }
      if (d.action === "drop-asked") {
        pending.current = [];
        bump("topicSuppressed", d.dropped.length);
        log("signal", `Topic already asked — ${d.dropped.length} repeated event(s) dropped, no question sent`, false);
        return;
      }
      // d.action === "nudge"
      pending.current = [];
      d.events.forEach((e) => askedTopics.current.add(e.topic));
      if (d.dropped.length) bump("topicSuppressed", d.dropped.length);
      convRef.current.sendUserMessage(buildNudgeMessage(d.events, idle));
      lastNudge.current = t;
      awaitingAnswerSince.current = t;
      bump("nudges");
      log("signal", `Pause detected (${(idle / 1000).toFixed(1)}s idle) → nudged with ${d.events.length} event(s)${d.dropped.length ? `, ${d.dropped.length} repeated topic(s) dropped` : ""}`);
    }, 400);
    return () => clearInterval(iv);
  }, [log]);

  /* ---------- screen capture + frames + vision ---------- */
  const shareScreen = async (): Promise<boolean> => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 },
        audio: false,
        // @ts-expect-error Chrome-only hints
        preferCurrentTab: true,
        selfBrowserSurface: "include",
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const surface = stream.getVideoTracks()[0].getSettings().displaySurface;
      stream.getVideoTracks()[0].onended = () => { setSharing(false); setShareEnded(true); };
      setSharing(true);
      setShareEnded(false);
      log("system", `Screen capture started (${surface ?? "unknown"} surface). Redaction boxes ${surface === "browser" ? "aligned to this tab" : "NOT aligned — share THIS tab for redaction"}.`, false);
      return true;
    } catch (e) {
      setError(e instanceof Error && e.name === "NotAllowedError"
        ? "Screen sharing was declined. Click Start session again and choose this tab."
        : `Screen share failed: ${e}`);
      return false;
    }
  };

  /* ---------- one primary action: share the tab, then connect voice ---------- */
  const startAll = async () => {
    if (!sharing) {
      const ok = await shareScreen();
      if (!ok) return;
    }
    await startVoice();
  };
  const finishAll = () => {
    endSession();
    streamRef.current?.getTracks().forEach((tr) => tr.stop());
    streamRef.current = null;
    setSharing(false);
    setShareEnded(false);
  };

  useEffect(() => {
    if (!sharing) return;
    const iv = setInterval(async () => {
      if (offRef.current) return; // off the record: no frames captured or sent
      const v = videoRef.current, cv = canvasRef.current;
      if (!v || !cv || !v.videoWidth) return;
      const W = 960, H = Math.round((v.videoHeight / v.videoWidth) * W);
      cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d")!;
      ctx.drawImage(v, 0, 0, W, H);
      // Redact BEFORE the frame leaves the browser: black out every [data-redact] element.
      const sx = W / window.innerWidth, sy = H / window.innerHeight;
      document.querySelectorAll<HTMLElement>("[data-redact]").forEach((el) => {
        const r = el.getBoundingClientRect();
        ctx.fillStyle = "#000";
        ctx.fillRect(r.left * sx - 4, r.top * sy - 4, r.width * sx + 8, r.height * sy + 8);
      });
      const url = cv.toDataURL("image/jpeg", 0.6);
      const f: Frame = { id: nextId++, t: now(), url };
      latestFrame.current = f;
      setFrames((fs) => [...fs.slice(-150), f]);

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
        if (j.error) setError(`Vision: ${j.error}`.slice(0, 300));
        else {
          setError((prev) => (prev.startsWith("Vision:") ? "" : prev));
          if (j.text && !j.text.includes("NO_CHANGE") && !offRef.current) {
            bump("visionHits");
            screenEvent("vision", j.text, visionTopic(j.text));
          }
        }
      } finally {
        visionBusy.current = false;
      }
    }, FRAME_MS);
    return () => clearInterval(iv);
  }, [sharing, screenEvent]);

  /* ---------- off the record: stop ALL outgoing audio, frames, events ---------- */
  const toggleOff = () => {
    const next = !offRef.current;
    offRef.current = next;
    setOffRecord(next);
    setMuted(next);
    if (next) pending.current = [];
    // marker only, no content, no frame
    setEntries((xs) => [...xs, { id: nextId++, t: now(), kind: "system", text: next ? "⏸ Off the record — mic muted, no frames, no events sent" : "▶ Back on the record" }]);
  };

  /* ---------- give me a moment: keep recording, hold questions ---------- */
  const toggleHold = () => {
    const holding = holdUntil.current > now();
    holdUntil.current = holding ? 0 : now() + HOLD_MS;
    setHoldLeft(holding ? 0 : HOLD_MS);
    setEntries((xs) => [...xs, {
      id: nextId++, t: now(), kind: "system",
      text: holding
        ? "▶ Moment over — questions allowed again"
        : `✋ Give me a moment — still recording, questions held for ${HOLD_MS / 1000}s or until tapped again`,
    }]);
  };

  /* ---------- sandbox invoice field changes -> app events ---------- */
  const edit = (field: keyof Invoice, label: string) => (val: string) => {
    setInvoice((inv) => ({ ...inv, [field]: val }));
    clearTimeout(fieldTimers.current[field]);
    fieldTimers.current[field] = setTimeout(() => {
      const before = prevInvoice.current[field];
      if (before === val) return;
      prevInvoice.current = { ...prevInvoice.current, [field]: val };
      screenEvent("app", `${label} changed "${before}" → "${val}" on ${invoice.id} (${invoice.vendor}, €${invoice.amount})`, appTopic(invoice.id, label));
    }, 900);
  };
  const save = () => screenEvent("app", `Save clicked on ${invoice.id}: category="${invoice.category}", cost center=${invoice.costCenter}, amount=€${invoice.amount}`, appTopic(invoice.id, "save"));

  const exportSession = () => {
    const blob = new Blob([JSON.stringify({ entries, frames, stats }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `understudy-gate-${Date.now()}.json`;
    a.click();
  };

  /* ---------- derived view data ---------- */
  const frameById = useMemo(() => new Map(frames.map((f) => [f.id, f])), [frames]);
  const transcript = useMemo(() => entries.filter((e) => e.kind === "expert" || e.kind === "agent"), [entries]);
  const lastAgent = useMemo(() => [...transcript].reverse().find((e) => e.kind === "agent")?.text, [transcript]);
  const lastExpert = useMemo(() => [...transcript].reverse().find((e) => e.kind === "expert")?.text, [transcript]);
  const moments = useMemo(
    () => entries.filter((e) => e.frameId && (e.kind === "app" || e.kind === "vision" || e.kind === "expert") && frameById.has(e.frameId)),
    [entries, frameById]
  );
  const selectedFrame = selected?.frameId ? frameById.get(selected.frameId) : undefined;
  const holding = holdLeft > 0;
  const orbState = !connected || offRecord ? "off" : conversation.mode === "speaking" ? "speaking" : thinking ? "thinking" : "listening";
  const orbLabel = !connected ? "Not connected" : offRecord ? "Off the record" : orbState === "speaking" ? "Speaking" : orbState === "thinking" ? "Thinking…" : "Listening";
  const pass = {
    ctx: stats.ctxSent > 0,
    asked: stats.answeredNudges > 0,
    quiet: stats.suppressed > 0,
    vision: stats.visionHits > 0,
    linked: stats.linked > 0,
    topic: stats.topicSuppressed > 0,
  };

  return (
    <div className="wrap">
      <header className="topbar">
        <span className="brand"><span className="dot" aria-hidden />Understudy</span>
        {(sharing || connected) && (
          <span className={`rec ${offRecord ? "paused" : ""}`}>
            <span className="reddot" aria-hidden />{offRecord ? "Paused" : "Recording"}
          </span>
        )}
        <span className={`pill ${connected ? "ok" : ""}`}>voice {connected ? "on" : status === "disconnected" ? "off" : status}</span>
        <span className={`pill ${sharing ? "ok" : ""}`}>screen {sharing ? "on" : "off"}</span>
        <div className="spacer" />
        <button className={`btn ${holding ? "holding" : ""}`} onClick={toggleHold} title="Recording continues; questions are held for 60 seconds">
          {holding ? `I'm ready (${Math.ceil(holdLeft / 1000)}s)` : "Give me a moment"}
        </button>
        <button className="switch" aria-pressed={offRecord} onClick={toggleOff} title="Stops the mic, frames and events entirely">
          <span className="track" aria-hidden><span className="knob" /></span>
          Off the record
        </button>
        {!connected
          ? <button className="btn primary" onClick={startAll}>Start session</button>
          : <button className="btn primary" onClick={finishAll}>Finish</button>}
        <button className="btn subtle" onClick={() => setShowTest((v) => !v)} title="Keyboard: Shift+T">Testing</button>
      </header>

      {shareEnded && (
        <div className="banner" role="status">
          Screen sharing ended. Your captured evidence is safe — share this tab again to continue.
          <button className="btn" onClick={shareScreen}>Share this tab</button>
          <button className="x" aria-label="Dismiss" onClick={() => setShareEnded(false)}>×</button>
        </div>
      )}
      {voiceDropped && !connected && (
        <div className="banner" role="status">
          Voice disconnected. All captured evidence is kept.
          <button className="btn" onClick={startVoice}>Reconnect</button>
          <button className="x" aria-label="Dismiss" onClick={() => setVoiceDropped(false)}>×</button>
        </div>
      )}
      {error && (
        <div className="banner errb" role="alert">
          {error}
          <button className="x" aria-label="Dismiss" onClick={() => setError("")}>×</button>
        </div>
      )}

      <main className="main">
        <section className="card erp" aria-label="Sandbox ERP">
          <span className="sandboxTag">Sandbox — fictional company and invoices</span>
          <h2>Invoice queue</h2>
          <div className="queue">
            <div className="qrow qhead"><span>Invoice</span><span>Vendor</span><span>Amount</span><span>Status</span></div>
            <div className="qrow"><span>{invoice.id}</span><span>{invoice.vendor}</span><span>€{invoice.amount}</span><span className="chip">Open</span></div>
          </div>

          <h2>Invoice {invoice.id}</h2>
          <div className="form">
            <label htmlFor="f-amount">Amount (€)</label>
            <input id="f-amount" value={invoice.amount} onChange={(e) => edit("amount", "Amount")(e.target.value)} />
            <label htmlFor="f-cat">Category</label>
            <select id="f-cat" value={invoice.category} onChange={(e) => edit("category", "Category")(e.target.value)}>
              <option>Operating expense</option>
              <option>Capital expenditure</option>
              <option>Intercompany</option>
            </select>
            <label htmlFor="f-cc">Cost center</label>
            <input id="f-cc" value={invoice.costCenter} onChange={(e) => edit("costCenter", "Cost center")(e.target.value)} />
            <label>Vendor IBAN</label>
            <div className="ro"><span className="iban" data-redact>{invoice.iban}</span></div>
          </div>
          <div className="saveRow">
            <button className="btn" onClick={save}>Save invoice</button>
          </div>

          <div className="moments">
            <h4>Captured moments</h4>
            <div className="momentRow">
              {moments.length === 0 && <span className="none">Moments appear here as Understudy watches you work.</span>}
              {moments.map((m) => (
                <button key={m.id} className="moment" onClick={() => setSelected(m)}>
                  <img src={frameById.get(m.frameId!)!.url} alt={`Screen at ${clock(m.t)}`} />
                  <span className="mlabel">{clock(m.t)} · {m.kind === "expert" ? "answer" : m.text}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="card companion" aria-label="Voice companion">
          <div className="orbWrap">
            <div className={`orb ${orbState}`} aria-hidden />
            <div className="orbLabel" aria-live="polite">{orbLabel}</div>
          </div>
          <div className="caption" aria-live="polite">
            {lastAgent ?? (connected ? "Just work normally. I'll only ask when you pause." : "Click Start session to begin.")}
          </div>
          {lastExpert && <div className="caption expertCap">“{lastExpert}”</div>}
          <div className="transcript">
            {transcript.length === 0 && <div className="empty">The conversation will appear here.</div>}
            {transcript.map((e) => (
              <div key={e.id} className={`line ${e.kind}`}>
                <span className="who">{e.kind === "agent" ? "Understudy" : "Expert"}</span>
                <span>{e.text}</span>
                {e.frameId && frameById.has(e.frameId) && (
                  <button className="cam" title="See the screen moment" aria-label="See the screen moment" onClick={() => setSelected(e)}>📷</button>
                )}
              </div>
            ))}
          </div>
        </aside>
      </main>

      {toast && <div className="toast" role="status">✓ {toast}</div>}

      {selected && selectedFrame && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Captured screen moment">
            <div className="mhead">
              <span className="k">{KIND_LABEL[selected.kind]}</span>
              <time>{clock(selected.t)}</time>
              <button className="x" aria-label="Close" onClick={() => setSelected(null)}>×</button>
            </div>
            <img src={selectedFrame.url} alt={`Redacted screen capture at ${clock(selected.t)}`} />
            <p className="q">{selected.kind === "expert" ? `“${selected.text}”` : selected.text}</p>
          </div>
        </div>
      )}

      {showTest && (
        <div className="drawer" role="region" aria-label="Testing panel">
          <h3>Testing panel <button className="x" aria-label="Close" onClick={() => setShowTest(false)}>×</button></h3>

          <div>
            <h4>Gate checks</h4>
            <ul className="checks">
              <li className={pass.ctx ? "y" : ""}>Screen events delivered as context ({stats.ctxSent})</li>
              <li className={pass.asked ? "y" : ""}>Agent asked after a pause ({stats.answeredNudges}/{stats.nudges} nudges answered)</li>
              <li className={pass.quiet ? "y" : ""}>Held back while expert was active ({stats.suppressed} ticks)</li>
              <li className={pass.vision ? "y" : ""}>Vision saw a real screen change ({stats.visionHits})</li>
              <li className={pass.linked ? "y" : ""}>Transcript linked to screenshots ({stats.linked})</li>
              <li className={pass.topic ? "y" : ""}>Repeated topic never asked twice ({stats.topicSuppressed} dropped)</li>
            </ul>
          </div>

          <div className="tune">
            <h4>Timing</h4>
            <div className="statline">idle {(idleFor / 1000).toFixed(1)}s · voice {status}{connected ? ` · ${conversation.mode}` : ""}</div>
            <label>Pause before asking: {(pauseMs / 1000).toFixed(1)}s
              <input type="range" min={1000} max={6000} step={250} value={pauseMs} onChange={(e) => setPauseMs(+e.target.value)} /></label>
            <label>Min gap between questions: {cooldownMs / 1000}s
              <input type="range" min={5000} max={90000} step={5000} value={cooldownMs} onChange={(e) => setCooldownMs(+e.target.value)} /></label>
          </div>

          <div className="row">
            <h4 style={{ width: "100%" }}>Debug actions</h4>
            <button className="btn" onClick={shareScreen} disabled={sharing}>Share tab</button>
            {!connected ? <button className="btn" onClick={startVoice}>Start voice only</button> : <button className="btn" onClick={() => endSession()}>End voice</button>}
            <button className="btn" onClick={exportSession}>Export session JSON</button>
          </div>

          <div>
            <h4>Raw event stream</h4>
            <div className="entries">
              {entries.map((e) => (
                <div key={e.id} className={`e ${e.kind} ${selected?.id === e.id ? "sel" : ""}`} onClick={() => e.frameId && frameById.has(e.frameId) && setSelected(e)}>
                  <span className="t">{clock(e.t)}</span>
                  <span>
                    <span className="k">{KIND_LABEL[e.kind]}{e.frameId ? " 📷" : ""}</span>
                    {e.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
