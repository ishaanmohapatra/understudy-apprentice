"use client";

import { Conversation } from "@elevenlabs/client";
import { useCallback, useEffect, useRef, useState } from "react";

/* ---------- tunables (change live in the UI) ---------- */
const FRAME_MS = 2000; // screen frame every 2s
const VISION_EVERY = 2; // send every Nth frame to vision (=4s)
const SPEECH_QUIET_MS = 1500; // expert must be silent this long
const VAD_SPEAKING = 0.6;

type Kind = "app" | "vision" | "signal" | "expert" | "agent" | "system";
type Entry = { id: number; t: number; kind: Kind; text: string; frameId?: number };
type Frame = { id: number; t: number; url: string };
type Invoice = { id: string; vendor: string; amount: string; category: string; costCenter: string; iban: string };

const KIND_LABEL: Record<Kind, string> = {
  app: "SCREEN · app event",
  vision: "SCREEN · vision",
  signal: "APP SIGNAL (not speech)",
  expert: "EXPERT said",
  agent: "APPRENTICE said",
  system: "system",
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

export default function Gate() {
  /* ---------- UI state ---------- */
  const [entries, setEntries] = useState<Entry[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [status, setStatus] = useState("disconnected");
  const [agentMode, setAgentMode] = useState("listening");
  const [sharing, setSharing] = useState(false);
  const [offRecord, setOffRecord] = useState(false);
  const [invoice, setInvoice] = useState<Invoice>(START_INVOICE);
  const [pauseMs, setPauseMs] = useState(2500);
  const [cooldownMs, setCooldownMs] = useState(20000);
  const [idleFor, setIdleFor] = useState(0);
  const [stats, setStats] = useState({ ctxSent: 0, nudges: 0, suppressed: 0, answeredNudges: 0, visionHits: 0, linked: 0 });
  const [error, setError] = useState("");

  /* ---------- refs used inside timers/callbacks ---------- */
  const conv = useRef<Awaited<ReturnType<typeof Conversation.startSession>> | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const offRef = useRef(false);
  const lastActivity = useRef(now());
  const lastSpeech = useRef(0);
  const lastNudge = useRef(0);
  const lastActivityPing = useRef(0);
  const agentSpeaking = useRef(false);
  const pending = useRef<string[]>([]);
  const latestFrame = useRef<Frame | null>(null);
  const lastVisionFrame = useRef<string | undefined>(undefined);
  const frameCount = useRef(0);
  const visionBusy = useRef(false);
  const awaitingAnswerSince = useRef(0);
  const prevInvoice = useRef<Invoice>(START_INVOICE);
  const fieldTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pauseRef = useRef(pauseMs);
  const cooldownRef = useRef(cooldownMs);
  pauseRef.current = pauseMs;
  cooldownRef.current = cooldownMs;

  const bump = (k: keyof typeof stats, n = 1) => setStats((s) => ({ ...s, [k]: s[k] + n }));

  const log = useCallback((kind: Kind, text: string, attachFrame = true) => {
    const e: Entry = { id: nextId++, t: now(), kind, text, frameId: attachFrame ? latestFrame.current?.id : undefined };
    if (e.frameId && (kind === "expert" || kind === "agent")) bump("linked");
    setEntries((xs) => [...xs, e]);
    return e;
  }, []);

  /* ---------- screen events -> agent context ---------- */
  const screenEvent = useCallback(
    (kind: "app" | "vision", text: string) => {
      if (offRef.current) return; // off the record: nothing recorded, nothing sent
      log(kind, text);
      pending.current.push(`${kind === "app" ? "[app]" : "[vision]"} ${text}`);
      if (conv.current) {
        conv.current.sendContextualUpdate(`[SCREEN · ${kind === "app" ? "app event" : "vision"} @ ${clock(now())}] ${text}`);
        bump("ctxSent");
      }
    },
    [log]
  );

  /* ---------- activity detection ---------- */
  useEffect(() => {
    const onAct = () => {
      lastActivity.current = now();
      if (conv.current && !offRef.current && now() - lastActivityPing.current > 500) {
        conv.current.sendUserActivity(); // tells the agent not to barge in
        lastActivityPing.current = now();
      }
    };
    const evs = ["keydown", "mousedown", "mousemove", "wheel", "input"] as const;
    evs.forEach((e) => window.addEventListener(e, onAct, { passive: true }));
    return () => evs.forEach((e) => window.removeEventListener(e, onAct));
  }, []);

  /* ---------- pause detector -> nudge ---------- */
  useEffect(() => {
    const iv = setInterval(() => {
      const t = now();
      const idle = t - lastActivity.current;
      setIdleFor(idle);
      const c = conv.current;
      if (!c || offRef.current || pending.current.length === 0) return;
      const quietInput = idle >= pauseRef.current;
      const quietVoice = t - lastSpeech.current >= SPEECH_QUIET_MS && !agentSpeaking.current;
      const cooled = t - lastNudge.current >= cooldownRef.current;
      if (!quietInput || !quietVoice) {
        // count events we *held back* because the expert was busy (proves no interruption)
        if (cooled && idle < 300) bump("suppressed");
        return;
      }
      if (!cooled) return;
      const evs = pending.current.splice(0);
      const msg =
        `[APP SIGNAL — generated by the app, NOT spoken by the expert] ` +
        `No keyboard/mouse input for ${(idle / 1000).toFixed(1)}s and no speech. ` +
        `Screen events since your last question:\n- ${evs.join("\n- ")}\n` +
        `If one of these is a decision whose reason is NOT visible on screen, ask ONE short "why" question now ` +
        `(prefer rules, limits, exceptions, who to ask). Never ask about something visible. ` +
        `If nothing is worth asking, call skip_turn and say nothing.`;
      c.sendUserMessage(msg);
      lastNudge.current = t;
      awaitingAnswerSince.current = t;
      bump("nudges");
      log("signal", `Pause detected (${(idle / 1000).toFixed(1)}s idle) → nudged with ${evs.length} event(s)`);
    }, 400);
    return () => clearInterval(iv);
  }, [log]);

  /* ---------- screen capture + frames + vision ---------- */
  const shareScreen = async () => {
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
      stream.getVideoTracks()[0].onended = () => setSharing(false);
      setSharing(true);
      log("system", `Screen capture started (${surface ?? "unknown"} surface). Redaction boxes ${surface === "browser" ? "aligned to this tab" : "NOT aligned — share THIS tab for redaction"}.`, false);
    } catch (e) {
      setError(`Screen share failed: ${e}`);
    }
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
        else if (j.text && !j.text.includes("NO_CHANGE") && !offRef.current) {
          bump("visionHits");
          screenEvent("vision", j.text);
        }
      } finally {
        visionBusy.current = false;
      }
    }, FRAME_MS);
    return () => clearInterval(iv);
  }, [sharing, screenEvent]);

  /* ---------- voice session ---------- */
  const start = async () => {
    setError("");
    setStatus("connecting");
    try {
      const r = await fetch("/api/signed-url");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      conv.current = await Conversation.startSession({
        signedUrl: j.signedUrl,
        connectionType: "websocket",
        onConnect: () => setStatus("connected"),
        onDisconnect: () => { setStatus("disconnected"); conv.current = null; },
        onError: (m: unknown) => setError(`Voice: ${String(m)}`),
        onStatusChange: ({ status }: { status: string }) => setStatus(status),
        onModeChange: ({ mode }: { mode: string }) => {
          agentSpeaking.current = mode === "speaking";
          setAgentMode(mode);
        },
        onVadScore: ({ vadScore }: { vadScore: number }) => {
          if (vadScore > VAD_SPEAKING) lastSpeech.current = now();
        },
        onMessage: ({ message, role }: { message: string; role: string }) => {
          if (message.startsWith("[APP SIGNAL")) return; // already logged as a signal, never as speech
          if (role === "user") {
            lastSpeech.current = now();
            if (!offRef.current) log("expert", message);
          } else {
            if (awaitingAnswerSince.current && now() - awaitingAnswerSince.current < 20000) {
              bump("answeredNudges");
              awaitingAnswerSince.current = 0;
            }
            log("agent", message);
          }
        },
      });
    } catch (e) {
      setStatus("disconnected");
      setError(String(e));
    }
  };
  const stop = async () => { await conv.current?.endSession(); conv.current = null; };

  /* ---------- off the record: stop ALL outgoing audio, frames, events ---------- */
  const toggleOff = () => {
    const next = !offRef.current;
    offRef.current = next;
    setOffRecord(next);
    conv.current?.setMicMuted(next);
    if (next) pending.current = [];
    // marker only, no content, no frame
    setEntries((xs) => [...xs, { id: nextId++, t: now(), kind: "system", text: next ? "⏸ OFF THE RECORD — mic muted, no frames, no events sent" : "▶ Back on the record" }]);
  };

  /* ---------- sandbox invoice field changes -> app events ---------- */
  const edit = (field: keyof Invoice, label: string) => (val: string) => {
    setInvoice((inv) => ({ ...inv, [field]: val }));
    clearTimeout(fieldTimers.current[field]);
    fieldTimers.current[field] = setTimeout(() => {
      const before = prevInvoice.current[field];
      if (before === val) return;
      prevInvoice.current = { ...prevInvoice.current, [field]: val };
      screenEvent("app", `${label} changed "${before}" → "${val}" on ${invoice.id} (${invoice.vendor}, €${invoice.amount})`);
    }, 900);
  };
  const save = () => screenEvent("app", `Save clicked on ${invoice.id}: category="${invoice.category}", cost center=${invoice.costCenter}, amount=€${invoice.amount}`);

  const exportSession = () => {
    const blob = new Blob([JSON.stringify({ entries, frames, stats }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `understudy-gate-${Date.now()}.json`;
    a.click();
  };

  const frameFor = (e: Entry | null) => (e?.frameId ? frames.find((f) => f.id === e.frameId) : undefined);
  const connected = status === "connected";
  const pass = {
    ctx: stats.ctxSent > 0,
    asked: stats.answeredNudges > 0,
    quiet: stats.suppressed > 0,
    vision: stats.visionHits > 0,
    linked: stats.linked > 0,
  };

  return (
    <div className="wrap">
      <header>
        <b>Understudy · integration gate</b>
        <span className={`pill ${connected ? "ok" : ""}`}>voice: {status}{connected ? ` · ${agentMode}` : ""}</span>
        <span className={`pill ${sharing ? "ok" : ""}`}>screen: {sharing ? "capturing" : "off"}</span>
        <span className={`pill ${offRecord ? "warn" : ""}`}>{offRecord ? "OFF THE RECORD" : "recording"}</span>
        <span className="pill">idle {(idleFor / 1000).toFixed(1)}s</span>
        <div className="spacer" />
        {!connected ? <button onClick={start}>Start voice</button> : <button onClick={stop}>End voice</button>}
        <button onClick={shareScreen} disabled={sharing}>Share this tab</button>
        <button className={offRecord ? "warnbtn" : ""} onClick={toggleOff}>{offRecord ? "Resume recording" : "Off the record"}</button>
        <button onClick={exportSession}>Export JSON</button>
      </header>
      {error && <div className="err">{error}</div>}

      <main>
        <section className="card">
          <h3>Sandbox ERP <small>(fictional data)</small></h3>
          <div className="inv">
            <label>Invoice</label><div>{invoice.id}</div>
            <label>Vendor</label><div>{invoice.vendor}</div>
            <label>Amount (€)</label>
            <input value={invoice.amount} onChange={(e) => edit("amount", "Amount")(e.target.value)} />
            <label>Category</label>
            <select value={invoice.category} onChange={(e) => edit("category", "Category")(e.target.value)}>
              <option>Operating expense</option>
              <option>Capital expenditure</option>
              <option>Intercompany</option>
            </select>
            <label>Cost center</label>
            <input value={invoice.costCenter} onChange={(e) => edit("costCenter", "Cost center")(e.target.value)} />
            <label>Vendor IBAN</label><div data-redact>{invoice.iban}</div>
          </div>
          <button onClick={save}>Save invoice</button>

          <h3>Gate checks</h3>
          <ul className="checks">
            <li className={pass.ctx ? "y" : ""}>Screen events delivered as context ({stats.ctxSent})</li>
            <li className={pass.asked ? "y" : ""}>Agent asked after a pause ({stats.answeredNudges}/{stats.nudges} nudges answered)</li>
            <li className={pass.quiet ? "y" : ""}>Held back while expert was active ({stats.suppressed} ticks)</li>
            <li className={pass.vision ? "y" : ""}>Vision saw a real screen change ({stats.visionHits})</li>
            <li className={pass.linked ? "y" : ""}>Transcript linked to screenshots ({stats.linked})</li>
          </ul>
          <div className="tune">
            <label>Pause before asking: {(pauseMs / 1000).toFixed(1)}s
              <input type="range" min={1000} max={6000} step={250} value={pauseMs} onChange={(e) => setPauseMs(+e.target.value)} /></label>
            <label>Min gap between questions: {cooldownMs / 1000}s
              <input type="range" min={5000} max={90000} step={5000} value={cooldownMs} onChange={(e) => setCooldownMs(+e.target.value)} /></label>
          </div>
        </section>

        <section className="card log">
          <h3>Session log <small>click a line to see its screenshot</small></h3>
          <div className="entries">
            {entries.map((e) => (
              <div key={e.id} className={`e ${e.kind} ${selected?.id === e.id ? "sel" : ""}`} onClick={() => setSelected(e)}>
                <span className="t">{clock(e.t)}</span>
                <span className="k">{KIND_LABEL[e.kind]}</span>
                <span className="x">{e.text}</span>
                {e.frameId && <span className="cam">📷</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="card shot">
          <h3>Screenshot</h3>
          {frameFor(selected) ? (
            <>
              <img src={frameFor(selected)!.url} alt="captured frame" />
              <p><small>Frame at {clock(frameFor(selected)!.t)} · linked to: “{selected!.text.slice(0, 120)}”</small></p>
            </>
          ) : latestFrame.current ? (
            <>
              <img src={frames[frames.length - 1]?.url} alt="latest frame" />
              <p><small>Live (latest redacted frame)</small></p>
            </>
          ) : (
            <p><small>Share this tab to start capturing.</small></p>
          )}
        </section>
      </main>
      <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}
