# Supported Platforms and Applications

Status columns: **planned → in development → fixture-tested → live-verified**.
Nothing is called "supported" below live-verified. This file is the single source for
in-product "supported" labels; the clients read a generated copy of it from org config.

## Surfaces / platforms

| Surface | Platform | Status | Notes |
|---|---|---|---|
| Web app | Evergreen Chrome (pilot) | in development | Hackathon gate prototype exists; product build pending milestone B |
| Web app | Firefox / Safari | planned | After pilot |
| Extension | Chrome (MV3) | planned | Milestone C |
| Extension | Edge | planned | Chromium port after Chrome is live-verified |
| Desktop | macOS (proposed pilot OS) | planned | Milestone D; framework decision pending (Electron recommended) |
| Desktop | Windows | planned | Enterprise phase; Windows Graphics Capture + UI Automation |

## Applications (capture/coaching adapters)

| Application | Surface | Adapter status | Fixtures | Live checks | Known limits |
|---|---|---|---|---|---|
| Understudy controlled test site | Extension | planned | — | — | Built by us for milestone C step 1 |
| Understudy controlled test app | Desktop | planned | — | — | Built by us for milestone D step 1 |
| Pilot browser app — `DECISION` | Extension | not selected | — | — | — |
| Pilot desktop app — `DECISION` | Desktop | not selected | — | — | — |

## Promotion rules

- planned → in development: adapter branch + fixture harness exists.
- in development → fixture-tested: regression harness green on sanitized/synthetic
  fixtures for the pinned app version.
- fixture-tested → live-verified: scheduled live compatibility checks green against the
  real application, capture-boundary tests pass, limits documented in the adapter README.
- Any live-check failure demotes the adapter to fixture-tested and disables it for orgs
  (fail clearly and safely: the surface shows "this application is currently unsupported").
