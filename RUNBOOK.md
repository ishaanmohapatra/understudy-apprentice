# Submission runbook — due Sunday 9:00 AM ET (submit by 8:00)

Everything below the keys is already built and tested (27 unit tests green; full
three-mode flow works keyless with labeled fallbacks). Times are budgets, not starts.

## 1 · Keys (15 min, the only true blocker)
- elevenlabs.io → profile → API key → `ELEVENLABS_API_KEY`.
- Create agent **Understudy Interviewer** from AGENT_PROMPT.md top section:
  system prompt + first message, enable **skip_turn**, voice = Expressive Mode
  (V3 Conversational), add `http://localhost:3000` + your Vercel domain to allowed
  origins → copy id → `ELEVENLABS_AGENT_ID`.
- Create agent **Understudy Tutor** from the bottom section → `ELEVENLABS_TUTOR_AGENT_ID`.
- console.anthropic.com → API key → `ANTHROPIC_API_KEY` (or use `OPENAI_API_KEY`).
- `cp .env.example .env.local`, fill, restart `npm run dev`.

## 2 · Gate check with real voice (30 min)
Chrome, share THIS tab. Run the brief's timing test 5×: type 10s (silence), stop
(one question ≤4/5), answer (linked 📷), repeat a change (no second question),
Give me a moment (held), Off the record (nothing sent — check the log marker).

## 3 · Full loop rehearsal (30 min)
Teach all 3 invoices per the brief's script (capex re-code; Kessler hold + note;
Czech CFO approval) → Finish → debrief: ask each gap by voice, answer, Next; teach-back;
correct one detail; **Confirm map** → Train: wrong account on INV-5001 (blocked, card,
tutor asks why), fix, asset number (R2 if taught), hints-off Kessler case → mastery
card → **Threshold proof** → €4,500 blocked under v2 → **Export Work Map JSON** →
commit the exported file into this repo.

## 4 · Deploy (10 min)
`npx vercel` (login) → project settings → add the 4 env vars → redeploy →
test mic + tab-share on the https link in a private window. Add the Vercel domain to
both agents' allowed origins.

## 5 · Record (90 min, one take per module, then stitch)
1080p, headset mic, zoom 110%, captions on. Follow the brief's minute-by-minute.
Keep the uncut recording; label any preloaded session; show the five-questions table.

## 6 · Slides (20 min)
SLIDES.md → 6 slides. Slide 4 = the five-questions table. Slide 5 ends on the
threshold proof.

## 7 · Submit (by 8:00 AM, buffer to 9:00)
Portal: video, live Vercel link, this public repo
(github.com/ishaanmohapatra/understudy-apprentice), slides, exported Work Map JSON.
Check every link in a private window. Anything else the portal requires: fill the
blank in the brief.
