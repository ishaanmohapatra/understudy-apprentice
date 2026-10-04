# ☀️ 5:15 AM — read this first (deadline 9:00, submit by 8:00)

Everything below the two SETUP blocks is rehearsed and machine-verified.
The whole three-mode flow already passed an automated browser run tonight.

## SETUP A — 2 minutes, two copy-pastes (your Anthropic key)
```bash
grep -m1 '^ANTHROPIC_API_KEY=' ~/Peerone-marketing-agent/backend/.env >> ~/Downloads/understudy/.env.local
cd ~/Downloads/understudy && grep -m1 '^ANTHROPIC_API_KEY=' .env.local | cut -d= -f2- | npx vercel env add ANTHROPIC_API_KEY production
```
Then tell Claude "key is in" — I'll verify vision+extraction live and redeploy.

## SETUP B — 10 minutes (ElevenLabs — needs YOUR account)
1. elevenlabs.io → sign in → API Keys → create → put in `.env.local` as `ELEVENLABS_API_KEY=`.
2. Agents → New agent → **Understudy Interviewer**: paste top section of AGENT_PROMPT.md
   (system prompt + first message), enable **skip_turn**, Expressive Mode voice.
   → id into `ELEVENLABS_AGENT_ID=`.
3. New agent → **Understudy Tutor**: bottom section of AGENT_PROMPT.md, skip_turn on.
   → id into `ELEVENLABS_TUTOR_AGENT_ID=`.
4. Tell Claude "voice keys in" — I restart, verify signed URLs for both agents,
   and push the three env vars to Vercel.

## SETUP C — 30 seconds (make the judge link public)
Open https://vercel.com/ishaanmohapatra2024-5136s-projects/understudy/settings/deployment-protection
→ Vercel Authentication → **Disabled** → Save. (It currently 302s to a login wall.)

## 5:45 — Rehearsal (30 min, localhost:3000, Chrome, headset)
Follow README's demo flow once, speaking as Sabine:
capex re-code + answer · Kessler hold + note · Czech second approval ·
guardrail answer · Finish · debrief by voice (Ask question → answer → Next ×3+) ·
teach-back, correct one detail · Confirm · Train: wrong account → blocked → fix →
asset number → hints-off case · mastery card · Threshold proof · **Export Work Map
JSON** → save into repo → `git add work-map-v2.json && git commit -m "demo export" && git push`.

## 6:15 — Record (90 min, one take per module, stitch after)
1080p, headset mic, zoom 110%, captions on (the app shows big captions).
Follow the brief's minute-by-minute (it's in the build brief PDF / README table).
Keep the uncut file. Re-record only the broken module, never the whole thing.

## 7:45 — Slides + submit (30 min)
Slides: open `slides.html` in Chrome, present or screen-record the 6 slides.
Portal: video · live link (the Vercel URL after SETUP C) · repo
github.com/ishaanmohapatra/understudy-apprentice · slides · exported Work Map JSON.
Check every link in a private window. Done by 8:00; 8–9 is buffer only.

## If anything breaks
Say "fix it" with what you saw. The keyless fallbacks are all labeled — the demo
degrades honestly, never fakes.
