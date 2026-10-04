# Understudy — The AI Apprentice

A voice apprentice watches an expert process supplier invoices, asks **why** at natural
pauses, turns the answers into a confirmed **Work Map**, then coaches a new hire through
a case the expert never showed — and stops the wrong save before it happens, in the
expert's own words.

Built for the ElevenLabs "AI Apprentice" challenge. **All data is fictional**
(sandbox company, invoices, policies — the policies live only in the expert's head and
the confirmed Work Map, never in this code).

One page, three modes: **1 · Teach Understudy → 2 · Review what it learned → 3 · Train a teammate.**

## Run it (5 min)

```bash
npm install
cp .env.example .env.local   # fill in the keys below
npm run dev                  # open http://localhost:3000 in Chrome
```

Keys: `ELEVENLABS_API_KEY` + two agents created from [AGENT_PROMPT.md](AGENT_PROMPT.md)
(`ELEVENLABS_AGENT_ID` interviewer, `ELEVENLABS_TUTOR_AGENT_ID` tutor — enable the
**skip_turn** system tool, Expressive Mode / V3 Conversational), and `ANTHROPIC_API_KEY`
(or `OPENAI_API_KEY`) for screen vision + Work Map extraction.

Without keys everything still runs honestly: questions appear as labeled on-screen
suggestions, and the draft keeps the expert's captured answers as evidence for one-click
rule creation instead of AI extraction. Nothing is ever simulated as if it were AI.

## The demo flow

1. **Teach** — Start session (share *this* tab so the IBAN is masked before any frame
   leaves the browser). Process the three invoices like a normal day; answer the spoken
   why-questions; *Give me a moment* holds questions, *Off the record* stops capture
   entirely. Finish.
2. **Review** — one careful model call drafts the Work Map + open questions. The spoken
   debrief asks the ranked gaps (guardrails first, then boundary values like "exactly
   €5,000"), then the teach-back. Counters show answered / deferred / unresolved. The
   expert fixes or removes rules — every rule shows her exact words — and confirms.
   Only confirmed rules ever reach the tutor.
3. **Train** — a new hire works INV-5001 (€7,200 milling head, never shown). Wrong
   account → Save blocks, the coaching card shows Sabine's words + screenshot, the tutor
   asks why. A hints-off case follows; the mastery card reports per rule: correct
   independently / with help / practice next.
4. **The signature proof** — click *Threshold proof*: Sabine says "Actually, it's 4,000
   now." Work Map v2 supersedes v1 (both never active), and a €4,500 invoice is now
   blocked **with no code change**. The training screen shows "Trained on Work Map v2".

## The five judge questions

| Question | Answer | See it |
|---|---|---|
| When to ask | Only when: an unasked event waits, no input ≥2.5s, no speech ≥1.5s, agent not talking, ≥20s since the last question. Keystrokes send activity so it never barges in. | Type 10s → silence; stop → one question |
| What to ask | Only why / limits / exceptions / "when would you stop and ask someone" — never what's visible; one per pause; topics never repeat (enforced in code, not just prompt). | The capex question, then a guardrail question |
| When it has understood | Every gap ends answered, deferred to a named person, or unresolved — counters on screen — then a confirmed teach-back. Deferrals never count as answered. | Review mode counters + teach-back |
| Did the new hire learn | Unseen €7,200 case caught before save, then a hints-off solo pass; mastery card per rule. One case = a result, not mastery. | Train mode |
| Trust | Off the record stops mic+frames+events (drops unsent); IBAN masked on-canvas before frames leave the browser; keys server-side; signed URLs; fictional-data banner. | Flip the switch mid-task; open any screenshot |

## Rule checks are code, not model judgment

`src/lib/rules.ts` is a deterministic evaluator over a closed field vocabulary
(amount, itemType, supplier, month, entity, account, assetNumber, approval,
paymentStatus; ops eq/gt/lt/in/missing). Anything the extractor can't express in that
vocabulary becomes an open question — never a guessed rule. Unknown situations say
"Sabine didn't cover this. Check with a person before saving." and name an escalation
only if she taught one.

**Tests:** `npm test` — 27 unit tests: the brief's full test table (R1/R2/R3, the €4,800
non-praise case, exactly-€5,000, Kessler March, unknown supplier), the v1→v2 threshold
supersession, vocabulary clamping, pause/cooldown/topic-suppression timing.

## Deploy

`npx vercel` → add the same env vars in the Vercel dashboard → test mic + tab-share on
the https URL in a private window.
