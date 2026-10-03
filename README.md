# Understudy — integration gate

Voice apprentice (ElevenLabs) that watches a sandbox invoice screen, asks "why" at natural pauses, and links every answer to a screenshot.

## Run (5 min)
1. `npm install`
2. `cp .env.example .env.local` and fill in `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, plus `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for vision.
3. Create the agent in ElevenLabs using `AGENT_PROMPT.md` (enable the **skip_turn** system tool).
4. `npm run dev` → open http://localhost:3000 in **Chrome**.
5. Click **Share this tab** (pick *this* tab, so redaction lines up) → **Start voice**.

## The gate test (pass = all 5 dots green)
1. Change cost center 4711 → 0400, then take your hands off the keyboard and mouse and stay quiet for about 3 seconds. The agent should ask *why*.
2. Answer out loud. Your answer appears as **EXPERT said** with a 📷. Click it to see the screenshot.
3. Type continuously for 10 seconds. The agent must **not** speak. The "held back" counter rises.
4. Switch Category to Capital expenditure. A **SCREEN · vision** line should appear within about 4 seconds.
5. Hit **Off the record**. Mic is muted, no frames are captured, no events are sent. Edit a field: nothing gets logged.

Labels: app events, vision, and pause signals are logged separately from the expert's speech, and the agent prompt says they are not speech.

## Deploy
`npx vercel` → add the same env vars in the Vercel dashboard → test mic and screen share on the https URL.
