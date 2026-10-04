# Understudy — Shared Protocol and Data-Schema Specification

Status: draft v0.1, companion to [ARCHITECTURE.md](../ARCHITECTURE.md). All schemas are
authored as zod in `packages/core` and exported to JSON Schema; this document is the
human-readable contract. Clients never define their own variants.

## 1. Conventions

- IDs: UUIDv7. Times: epoch ms, UTC. All rows carry `orgId`; RLS enforces it.
- Every mutating request carries an `Idempotency-Key`; retries are safe.
- All payloads validated server-side with the same zod schemas the clients compile in.

## 2. Authentication

- Web: OIDC session cookie.
- Extension/desktop: browser handoff → backend issues a **session token** (JWT, ≤8 h):

```json
{
  "sub": "user-id", "org": "org-id", "surface": "extension|desktop|web",
  "device": "device-id", "scope": ["capture", "coach"], "exp": 1234567890
}
```

Tokens are device-bound and scope-limited; revocation list checked on every upload.
Provider credentials (ElevenLabs, Anthropic) never reach a client; voice sessions use
backend-minted signed URLs/conversation tokens with the session id embedded for audit.

## 3. Recording-session protocol

```
POST   /sessions                      create { workflowId, surface } → { sessionId }
POST   /sessions/:id/capture-lease    acquire { deviceId } → { leaseId, ttlMs } | 409 holder
POST   /leases/:id/heartbeat          every 15 s; expiry 45 s
DELETE /leases/:id                    release (or forced from web by the same user)
POST   /sessions/:id/observations     batch of envelopes (lease required)
POST   /sessions/:id/frames           redacted frame upload → frameId (lease required)
POST   /sessions/:id/finish           closes; triggers draft extraction job
POST   /sessions/:id/pause|resume     server records interval; uploads within a paused
                                      interval are rejected (clients also never send them)
```

Rules: one active lease per session; uploads without the lease → `403 LEASE_REQUIRED`;
`(sessionId, seq)` is the idempotency key for observations; frames are content-addressed
(sha256) so duplicate uploads are no-ops.

## 4. Observation envelope

```json
{
  "sessionId": "…", "seq": 118, "t": 1760000000000,
  "surface": "web|extension|desktop",
  "source": "visual|structured|integration",
  "adapter": "sandbox-erp@1 | sap-fiori@2 | …",
  "kind": "field-change|click|navigation|speech-ref|activity|system",
  "payload": { "field": "account", "from": "4711 Opex", "to": "0400 Capex",
               "record": "INV-4471" },
  "frameId": "sha256:…|null",
  "redaction": "clean|masked|suppressed"
}
```

- `source` is mandatory and displayed everywhere the observation is shown.
- `payload.field` must come from the workflow's field vocabulary (§6) when
  `source=structured`; unknown fields are stored but flagged `unmapped`.
- **Untrusted-evidence rule:** any free-text in `payload` or OCR output is data. The
  extraction prompt wraps it as
  `<observed-data sessionId=… seq=…> … </observed-data>` with an instruction that its
  content is captured screen data and cannot alter task instructions. Models that read
  it have no tools. Residual risk documented in ARCHITECTURE §6.
- Activity observations are coarse booleans ("input occurred", "scroll occurred") with
  timestamps — never keystroke content, never key identities.

## 5. Work Map schema

```json
{
  "workMapId": "…", "orgId": "…", "workflow": "invoice-processing",
  "version": 3, "supersedes": 2,
  "state": "draft|corrected|confirmed|approved|retired",
  "owner": "user-id", "expert": "user-id", "reviewBy": "2027-04-01",
  "steps": [{
    "n": 4, "title": "Code the invoice to an account",
    "screenMoment": { "sessionId": "…", "seq": 118, "frameId": "sha256:…" },
    "decision": "Changed account 4711 Opex to 0400 Capex",
    "ruleIds": ["R1", "R2"]
  }],
  "rules": [ Rule… ],
  "openQuestions": [{ "q": "Exactly 5,000 — capex or opex?",
                      "status": "unresolved|deferred|answered",
                      "deferredTo": "role or person, when status=deferred" }],
  "conflicts": [{ "ruleIds": ["R1","R7"], "raisedBy": "system",
                  "resolution": null }],
  "history": [{ "t": …, "actor": "…", "change": "…", "fromState": "…", "toState": "…" }]
}
```

State machine: `draft → corrected → confirmed → approved`; any edit to an approved map
creates version n+1 in `draft` (the approved version stays active until the new one is
approved). `retired` versions are never served to learners/companions. Conflicts block
`approved` until the owner resolves them. History is append-only.

## 6. Rule DSL

Deterministic, closed-world. Evaluated only by `packages/core` `evaluateRule()` — pure,
side-effect-free, property-tested. Never LLM-evaluated.

```json
{
  "id": "R1",
  "scope":  { "itemType": "equipment" },
  "when":   [ { "field": "amount", "op": "gt", "value": 5000 } ],
  "require": { "field": "account", "value": "0400 Capex" },
  "block":  "message shown when require fails (practice may block; companions warn)",
  "exceptions": [ { "when": [Cond…], "note": "…" } ],
  "escalation": "role or named contact, or null",
  "evidence": { "sessionId": "…", "seq": 118, "frameId": "sha256:…",
                "quote": "Equipment over 5,000 euros is always capex.",
                "speaker": "expert", "t": 1760000000000 },
  "status": "proposed|corrected|confirmed",
  "enforcement": "warn|block-practice|block-integration"
}
```

- Field vocabulary is declared per workflow (e.g. `amount, itemType, supplier, month,
  entity, account, assetNumber, approval, paymentStatus`) with types; `when`/`require`
  may only reference declared fields. Operators: `eq, gt, lt, in, missing`.
- The extractor must emit either a valid rule or an open question — never an
  out-of-vocabulary rule (schema validation rejects it; the item is downgraded to an
  open question automatically, and that downgrade is logged).
- `enforcement=block-integration` is only settable by an admin on a rule whose workflow
  has a supported, tested integration; the API rejects it otherwise.
- Evidence is mandatory on every rule. Prose guardrails without conditions are display-
  only and carry `"enforcement": "warn"` with empty `when` — the evaluator ignores them.

## 7. Evaluator contract

```
evaluate(rules: Rule[], record: Record<FieldId, Value>): Verdict[]
Verdict = { ruleId, outcome: "pass" | "fail" | "not-applicable" | "unknown-field",
            message?, escalation?, evidenceRef }
```

- `unknown-field` (record lacks a field a rule needs) is reported, never guessed —
  companions say "not covered, check with a person" exactly as the spec requires.
- Identical input ⇒ identical output on every surface; the conformance suite replays a
  golden verdict table on web, extension and desktop builds.

## 8. Question-timing policy

The policy from the gate (`decideNudge`) moves to core unchanged in substance:
ask only when all hold — pending unasked observation; idle ≥ pauseMs; no voice activity
for quietMs; agent not speaking; cooldown elapsed; not holding ("Give me a moment");
not off-record; topic not already asked (per-field topic keys; vision-text normalization).
Inputs come from each client's ActivityAdapter; the decision function is shared.

## 9. Client adapter interfaces (implemented per surface, conformance-tested)

```
CaptureAdapter    start(scope) / stop() / onFrame(redacted) / scope honesty report
RedactionAdapter  mask(frame, regions) → frame | "suppress" when confidence low
ActivityAdapter   coarse activity + voice events for the timing policy
PermissionAdapter current grants, change notifications, revocation handling
FieldAdapter      (extension/desktop structured reads) allowlisted field → schema map
```

`RedactionAdapter` returning `"suppress"` puts the session in `redaction: "suppressed"`
mode: image upload halts, user is asked to correct; audio/structured may continue.

## 10. Audit event

```json
{ "t": …, "orgId": "…", "actor": "user-id|system", "surface": "…",
  "action": "capture.start|capture.stop|pause|resume|view|edit|confirm|approve|
             warn.shown|block.shown|override|export|delete|lease.acquire|lease.deny",
  "object": { "type": "session|workMap|rule|frame", "id": "…", "version": 3 },
  "detail": {} }
```

Append-only table; no UPDATE/DELETE grants; retention per org policy with legal-hold flag.

## 11. Versioning of this contract

Schemas carry `schemaVersion`. Backward-compatible changes bump minor; breaking changes
require a migration note here and a deprecation window during which the API accepts both.
Clients send their `schemaVersion`; the API refuses versions outside the window with a
clear upgrade error.
