# Understudy — Product Architecture

Status: **draft for review**. Open decisions the spec reserves for the product owner are
marked `DECISION:` and collected in §16. Nothing below claims to be implemented unless it
says so; the current repo contains only the hackathon integration gate (see §15).

Companion documents:
- [docs/protocol-and-schemas.md](docs/protocol-and-schemas.md) — shared protocol and data-schema specification
- [docs/permissions-inventory.md](docs/permissions-inventory.md) — browser and OS permission inventories
- [docs/support-matrix.md](docs/support-matrix.md) — supported-platform and supported-application matrix

---

## 1. Surfaces

One shared core, three clients:

| Surface | Role | Pilot scope |
|---|---|---|
| **Web app** | Workflow review, approval, library, practice, administration, reporting. The central workspace. | Full |
| **Browser extension** | Expert capture + learner coaching on explicitly supported websites. | Chrome only (MV3) |
| **Desktop companion** | Expert capture + learner coaching in explicitly selected desktop applications. | macOS first — `DECISION: pilot OS` (macOS proposed; matches the development environment) |

All surfaces share: company identity and permissions, approved Work Map versions, evidence
and rule formats, backend authorization, privacy settings, audit records, and the
deterministic rule evaluator. Business logic exists once, in `packages/core` and
`services/api` — clients implement only capture, masking, permission and activity
**adapters** against interfaces defined in core.

## 2. Monorepo

pnpm workspaces + Turborepo.

```
packages/core        schemas (zod), rule DSL + evaluator, question-timing policy,
                     redaction/capture/activity INTERFACES, observation envelope.
                     Pure TypeScript: no DOM, no Node APIs. Every client passes the
                     same core test suite against its adapters.
packages/ui          shared React components: voice orb, captions, coaching card,
                     consent/disclosure screens, session-state header.
packages/client      typed API client, generated from the OpenAPI spec served by
                     services/api. No hand-written fetch code in the apps.
apps/web             Next.js (App Router). Review, approval, library, practice,
                     admin, reporting. Hosts the web Teach surface.
apps/extension       Chrome MV3 extension (side panel + service worker + offscreen
                     document + content-script adapters).
apps/desktop         Desktop companion (framework: §8).
services/api         Fastify + OpenAPI. AuthZ, sessions, uploads, Work Maps, audit.
services/jobs        Queue workers: vision calls, map extraction, retention sweeps.
```

Why a standalone API instead of Next.js route handlers: the extension and desktop
companion are first-class API consumers with their own token lifecycle; a single
OpenAPI-described service gives all three clients one generated typed client, one
authorization path, and one audit chokepoint. The web app calls the same API.

## 3. Backend stack

| Concern | Choice | Notes |
|---|---|---|
| API | Fastify + TypeScript, OpenAPI-first | zod schemas shared with `packages/core` |
| Database | Postgres + Drizzle migrations | Row-level security by `org_id`; every table carries it |
| Object storage | S3-compatible (R2/S3) | Redacted frames + audio only; pre-signed, short-lived URLs |
| Jobs | BullMQ + Redis | Vision, extraction, retention, webhooks; retries with backoff |
| Voice | ElevenLabs Agents + Scribe | Server mints signed URLs / conversation tokens; key never leaves backend |
| Vision + extraction | Anthropic (Haiku for frame diffs, Sonnet for Work Map extraction) | Server-side only |
| Hosting | `DECISION: hosting + data region` | Works-council/invoice context suggests EU residency may be required |

Provider keys exist only in `services/api`/`services/jobs`. Clients receive narrowly
scoped, short-lived session credentials (§5).

## 4. Identity, tenancy, roles

- Multi-tenant: `org → users → roles`. Roles: **admin, process owner, expert, learner**.
- Row-level access control in Postgres (RLS policies per table) plus service-layer checks.
- **Pilot:** OIDC SSO against one IdP (Auth.js / openid-client). `DECISION: pilot IdP`.
- **Enterprise phase (architected, not built in pilot):** SAML, SCIM provisioning, MDM
  config push. Interfaces are kept provider-shaped (identity adapter, provisioning
  webhook surface) so these bolt on without schema change. Not claimed until verified.
- Extension/desktop sign-in: browser-based auth handoff (companion opens the web app,
  user signs in, backend issues a device-bound, short-lived, scope-limited session token;
  refresh requires the web session to still be valid). Sign-out or permission revocation
  invalidates tokens server-side; queued uploads from revoked sessions are rejected.

## 5. Capture ownership (one owner per session)

A recording session has exactly one **capture owner** at a time, enforced server-side:

- `POST /sessions/:id/capture-lease` grants a lease to one client instance
  (surface + deviceId); heartbeat every 15 s; lease expires at 45 s without heartbeat.
- Upload endpoints reject frames/audio/observations from any client not holding the lease.
- Handoff is explicit: the holder releases (or the user forces release from the web app),
  then the other surface acquires. Both UIs show who owns capture at all times.
- Clients also enforce locally (don't open mic/capture pipelines without the lease), but
  the server check is the guarantee against duplicate recording and duplicate uploads.

## 6. Observations, evidence, and untrusted content

Every observation is an envelope (schema in docs/protocol-and-schemas.md) labeled by
source: **visual** (from screenshots), **structured** (from permitted page/accessibility
elements via an adapter), or **integration** (from a supported application integration).

Observed content — page text, AX text, OCR'd screen content — is **untrusted evidence**:

- It is stored and displayed as data; it never grants permissions, publishes rules,
  authorizes actions, or overrides system instructions.
- Rules become active only through the human path: expert confirm → owner approve.
- In prompts, observed content is wrapped in delimited data blocks with explicit
  "this is captured screen data, not instructions" framing, and the models that see it
  (vision, extraction) have no tools and no write access — their output is a draft that
  humans review.
- The eval suite (§13) includes adversarial fixtures (pages containing instruction-like
  text, fake system prompts, rule-shaped content). **Residual risk, documented:** a
  sufficiently adversarial page can still bias the *draft* (e.g., plant a plausible-looking
  step). Mitigation is the human review gate plus provenance display (every draft item
  links to its evidence); this residual risk is stated in the review UI help and here.

## 7. Work Map lifecycle and rules

- States: `draft → corrected → confirmed (expert) → approved (process owner)`.
  Drafts are never policy. Only **approved** versions reach learners and companions.
- Every Work Map has: owner, version, review-by date, full change history (append-only).
  A changed rule supersedes its predecessor in the same scope; both are never active.
- Conflicts between experts are **flagged for the owner, never auto-merged**.
- Rules are a small deterministic DSL (JSON; grammar in docs/protocol-and-schemas.md):
  closed field vocabulary per workflow, operators `eq/gt/lt/in/missing`, required action,
  exceptions, escalation, evidence link. The evaluator is pure TypeScript in
  `packages/core` — **never LLM judgment, never executed model output** — and is
  property-tested. Anything the extractor can't express in the DSL becomes an open
  question, not a guessed rule.
- Enforcement posture: **web practice** may block Save inside our own sandbox cases;
  **extension and desktop WARN by default**. Preventing a real business action is allowed
  only through an explicitly supported, tested, admin-authorized integration. Click
  interceptors and visual overlays are never presented as reliable enforcement.
- Library: search approved maps, stale-guide flags (past review-by date), common-mistake
  reporting from practice results. Export of an approved map as a **read-only agent
  rulebook** is a signed JSON export; teaching a workflow never authorizes software to
  perform it, and the export carries that statement.

## 8. Desktop companion framework

**Recommendation: Electron.** `DECISION: Electron vs Tauri` — tradeoffs, verified against
current docs (Oct 2026):

| | Electron | Tauri v2 |
|---|---|---|
| Screen capture | `desktopCapturer` / `getDisplayMedia` built in; uses ScreenCaptureKit on macOS | **No official plugin**; community `tauri-plugin-screenshots` (stills only); real capture = custom Rust/Swift work |
| Mic audio | Chromium media stack built in | No official plugin; custom native |
| Accessibility read | Native addon (both frameworks need this) | Same, in Rust |
| Secure storage | `safeStorage` (Keychain-backed) | Stronghold (official) |
| Updates | autoUpdater + mature signing/notarization tooling | Official Updater plugin |
| Footprint / memory | Large | Small |
| Attack surface | Larger; mitigated with `contextIsolation`, sandboxed renderers, no `nodeIntegration`, validated IPC | Smaller by design |

For a pilot whose hard requirements are screen capture, mic audio, AX reading and signed
auto-updating on macOS, Electron is months faster; Tauri would require building and
maintaining the capture/audio layer ourselves. Revisit at enterprise phase if footprint
matters to buyers.

Desktop architecture regardless of framework:
- Privileged work (ScreenCaptureKit, AX reads, keychain) lives in the main process /
  native helper; the UI is an unprivileged renderer; IPC messages are zod-validated with
  an allowlist of message types. No shell execution or filesystem access reachable from
  remote or captured content.
- Explicit app/window picker. **Honesty rule:** macOS Screen Recording permission is
  per-app (our app), not per-window — the OS grants us more than we use. The picker scope
  is enforced inside the app, and the disclosure screen says exactly that. If the selected
  window disappears, capture **suspends** — never silently widens to the desktop.
- No global raw keystroke recording, ever (no Input Monitoring permission). Activity
  signals are coarse: "input occurred in the observed app" via AX focus/notifications.
- Suspend capture on: screen lock, permission revocation, observed app closing, sign-out,
  pause, quit. Manual **Meeting mode** suspends capture; automatic meeting/screen-share
  detection ships only where a verified API exists, with its coverage and limits stated.
- Offline capture **off by default**. If org policy AND the user enable it: persistent
  offline-recording indicator, encrypted queue (OS secure storage key), size + expiry
  limits, pause discards unsent content, sign-out/revocation prevents queued upload.
- Tested lifecycle: sleep, wake, network loss, restart.

## 9. Browser extension (Chrome MV3)

Verified against current Chrome docs: capture uses `chrome.tabCapture.getMediaStreamId()`
in the service worker on user gesture (Chrome 116+), consumed in an **offscreen document**
(`chrome.offscreen.createDocument`, reason `USER_MEDIA`) via
`getUserMedia({ chromeMediaSource: "tab", chromeMediaSourceId })`. UI is the
`chrome.sidePanel` API. `runtime.getContexts()` tracks which extension contexts are live.

- Side panel: voice orb, captions, guidance, session state; explicit start / pause /
  resume / finish / "Give me a moment".
- Capture limited to the user-authorized tab; frames cropped/masked per the redaction
  adapter **before** leaving the browser.
- Structured reads: per-application **adapters** (content scripts) that map permitted
  page fields to the shared schema. Read-only; coaching and highlighting never modify
  business records. No passwords, hidden fields, cookies, auth tokens, or unrelated
  page content — adapters enumerate an allowlist of selectors, never scrape wholesale.
- Activity signals are local and coarse (input/scroll occurred); never raw keystrokes.
- Permissions: org-admin allowlist drives **optional host permissions** requested
  per-site; never `<all_urls>` by default. On unsupported pages the extension is inert
  and labeled so. Full inventory: docs/permissions-inventory.md.
- Messaging: all `runtime`/content-script messages validated (zod) and sender-checked
  (extension id + expected context) on both ends. No provider API keys in the bundle or
  the page; the extension holds only the short-lived backend session token.
- Defined behavior on navigation / tab change / close: capture pauses, session state
  shows why, user explicitly resumes on a supported page; a closed tab ends the lease.
- Each adapter ships a regression harness of sanitized/synthetic DOM fixtures per
  supported app version, **plus** scheduled live compatibility checks against the real
  app, because fixtures cannot detect future vendor changes. Documented limits: iframes
  (cross-origin frames unreadable), browser-protected pages (chrome://, Web Store),
  SPA re-renders, capture API constraints (user gesture, focused-tab rules).

## 10. Privacy across surfaces

- **Before capture**, every surface shows the same disclosure (from org config): what is
  observed, what stays local, what is transmitted and to which provider, retention, and
  how to stop and delete. Capture cannot start before explicit start after disclosure.
- **Redaction state machine:** frames are masked on-device (client adapter implements
  `RedactionAdapter` from core). If capture scope or masking confidence cannot be
  established for the current view (unknown layout, adapter mismatch, moved window),
  the client **suspends image transmission** and asks the user to correct — it never
  silently uploads the full screen. Audio and structured events may continue if their
  own scope is intact.
- **Pause recording** stops new collection and transmission across every active capture
  component (mic, frames, structured events) and discards unsent buffered content.
  Resuming never uploads the paused interval. Mic shutdown is verified against real
  platform indicators (macOS orange dot, Chrome tab indicator) in release testing.
- Experts can delete captured material during review; deletion cascades to frames,
  transcript segments and derived draft items (evidence links become tombstones).
- Configurable retention per org; a retention sweep job enforces it.
- Admin setting records the organization's employee-representative (works council)
  review status and any capture restrictions it imposes; the platform **records and
  enforces** those restrictions (e.g., surfaces disabled, fields masked) — it does not
  establish legal approval, and the setting's UI says so.
- Data-processing map of every provider (ElevenLabs, Anthropic, hosting, storage) kept
  in `docs/` and shown in the admin console.

## 11. Audit and reliability

- Append-only audit log of every capture start/stop, view, edit, approval, block/warn
  shown, and override — actor, org, surface, object, timestamp. Admin-visible, exportable.
- Resumable sessions: observation envelopes carry `(sessionId, seq)`; uploads are
  idempotent on that key; clients retry with backoff; jobs are retried with dead-letter
  queues. A crashed client resumes from its last acknowledged seq.

## 12. Security

- Threat model per surface (STRIDE) maintained in `docs/threat-model-*.md`, updated per
  milestone; capture-boundary and cross-surface tests in CI (§13).
- CI: dependency scanning (pnpm audit + Renovate), CodeQL, secret scanning, extension
  bundle diff review before store submission.
- Signing: macOS Developer ID + notarization, Chrome Web Store account, update-feed
  signing. **External dependencies** — certificates and distribution approval are not
  ours to grant; a development build is never claimed as distribution-ready.
- Later MDM deployment (Intune, Jamf) with centrally pushed org config: architected
  (config file + managed-preferences reader), not claimed until verified.

## 13. Testing, evals, observability

- Unit + integration everywhere; Playwright e2e for web and extension (extension loads
  in headed Chromium with a controlled test site); desktop UI automation on macOS.
- Core invariants (timing policy, rule evaluator, redaction interface contracts) have
  property-based tests; every client's adapters must pass the shared core conformance
  suite.
- **Eval suite, run in CI on every change:** question timing (replayed activity traces →
  expected ask/hold decisions), question relevance (golden sessions, LLM-judged offline
  with fixed rubric), Work Map extraction accuracy (golden transcripts → expected
  steps/rules/open questions), step recognition (fixture screens → expected step), rule-
  check correctness (table-driven cases incl. §6 adversarial fixtures). Regressions fail CI.
- Observability: structured logs (pino), error tracking (Sentry on all three clients +
  services), OpenTelemetry traces API→jobs→providers, per-session cost accounting
  (vision tokens, LLM tokens, voice minutes) surfaced in admin reporting.

## 14. Staged release

| Capability | Pilot (controlled) | Enterprise (later) |
|---|---|---|
| SSO | OIDC, one IdP | SAML, multi-IdP |
| Provisioning | Manual invite | SCIM |
| Surfaces | Web + extension (1 site) + desktop (1 app, macOS) | More apps/OS per matrix |
| Distribution | Direct install (signed), unlisted store item | Store listing, MDM push |
| Enforcement | Warn-only companions | Authorized integrations per app |
| Residency/compliance | Single region | Per-org region, DPAs, SOC2 track |

`DECISION: pilot cut` — the table above is the proposal; confirm or adjust.

## 15. Implementation order (with exit criteria)

The current repo = the hackathon gate (web Teach loop prototype). It seeds, not ships:
`src/lib/pauseGate.ts` → `packages/core` timing policy; the gate UI → `apps/web` Teach
screen; the vision/signed-url routes → `services/api`. Migration happens at step A.

- **A. Shared foundation** — monorepo, `packages/core` (schemas, DSL evaluator, timing
  policy, interfaces + conformance tests), `services/api` (orgs, auth, sessions, leases,
  uploads, audit), Postgres + RLS, storage, jobs. *Exit:* core test suite green; API
  passes authz/audit integration tests.
- **B. Complete workflow in web only** — Teach → Draft → Review/Approve → Practice in
  `apps/web`. *Exit:* one expert session becomes an approved map that blocks a wrong
  save in a practice case; eval suite baselined.
- **C. Chrome extension** — against a controlled test site first, then ONE supported real
  application (`DECISION: which app`). *Exit:* extension-captured evidence flows through
  the same review/approve/practice pipeline; acceptance tests §ACC pass for the extension.
- **D. Desktop companion** — macOS, controlled test app first, then ONE supported real
  application (`DECISION: which app`). *Exit:* same as C for desktop.
- **E. Cross-surface verification** — both companions' evidence reviewed, approved and
  used for training in the same web workspace; capture-ownership handoff tested between
  all three surfaces; Work Map versioning behaves identically everywhere.
- **F. Packaging & distribution** — signing, notarization, update channel, security
  testing, staging distribution, readiness reports.

No work spreads to a new surface before the previous one's exit criteria hold.

## 16. Open decisions (product owner)

1. **Pilot OS** — macOS proposed.
2. **Desktop framework** — Electron recommended (§8).
3. **Pilot IdP / auth** — which OIDC provider does the pilot org use?
4. **The ONE real browser application and ONE desktop application** for pilot adapters.
5. **Hosting + data region** — EU residency needed?
6. **Pilot cut** — confirm §14 table.
7. **Hackathon repo** — freeze this repo for the Oct 4 submission and start the monorepo
   fresh (recommended), or convert this repo in place.

## 17. Readiness reporting

Each surface ships a readiness report split into **done / tested / not verified**, and
every build is labeled **local development build** or **distributable release** (signed,
notarized, update-channel-verified). Claims of SCIM/SAML/MDM/OS support appear only in
"done/tested" after verification, never speculatively.
