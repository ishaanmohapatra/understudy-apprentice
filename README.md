# Understudy — integration gate

Voice apprentice (ElevenLabs) that watches a sandbox invoice screen, asks "why" at natural pauses, and links every answer to a screenshot.

Built on the ElevenLabs **React SDK** (`@elevenlabs/react`: `ConversationProvider` + `useConversation`). The ask/stay-quiet decision logic is pure TypeScript in `src/lib/pauseGate.ts`, unit-tested with `npm test`. No business policy (thresholds, suppliers, routes) is in the code — the agent learns those from the expert's spoken answers.

## Run (5 min)
1. `npm install`
2. `cp .env.example .env.local` and fill in `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, plus `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for vision.
3. Create the agent in ElevenLabs using `AGENT_PROMPT.md` (enable the **skip_turn** system tool).
4. `npm run dev` → open http://localhost:3000 in **Chrome**.
5. Click **Start session** — it asks to share a tab (pick *this* tab, so redaction lines up), then connects the voice agent.

## The screen
- **Left:** the sandbox ERP (invoice queue + open invoice) — this is what gets captured. The IBAN is blacked out before any frame leaves the browser.
- **Right:** the voice companion — an orb showing *listening / thinking / speaking*, big captions for every spoken line, and the live transcript. 📷 on a line opens the linked screen moment.
- **Captured moments:** thumbnails under the invoice; click one to see the screenshot and the expert's words.
- **Testing panel** (button top-right, or `Shift+T`): gate checks, timing sliders, raw event stream, debug actions, JSON export.

## The two pause controls
- **Give me a moment** — recording continues (frames, events, mic all stay on), but questions are held for 60 s or until you tap it again. For when you're reading, not done.
- **Off the record** — mic muted, no frames captured, no events sent, pending events dropped. Nothing leaves the browser until you resume.

## The gate test (pass = all 6 dots green in the Testing panel)
1. Change cost center 4711 → 0400, then take your hands off the keyboard and mouse and stay quiet for about 3 seconds. The agent should ask *why*.
2. Answer out loud. Your answer appears as **EXPERT said** with a 📷. Click it to see the screenshot.
3. Type continuously for 10 seconds. The agent must **not** speak. The "held back" counter rises.
4. Switch Category to Capital expenditure. A **SCREEN · vision** line should appear within about 4 seconds.
5. Change cost center again (same field). After the next pause, no second question about it: the log shows "Topic already asked — dropped".
6. Tap **Give me a moment**, change a field, pause: no question until the hold ends. Then **Off the record**: edit a field — nothing is logged or sent.

Labels: app events, vision, and pause signals are logged separately from the expert's speech, and both the app signal text and the agent prompt state they are not speech.

## Automated checks
- `npm test` — 15 unit tests on the pause/cooldown/topic-suppression logic (`src/lib/pauseGate.test.ts`)
- `npx tsc --noEmit`, `npm run lint`, `npm run build` — all clean

## Deploy
`npx vercel` → add the same env vars in the Vercel dashboard → test mic and screen share on the https URL. API keys stay server-side; the browser only ever receives a short-lived signed URL.
