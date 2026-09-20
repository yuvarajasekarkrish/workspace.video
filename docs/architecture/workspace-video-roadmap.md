# workspace.video: what is missing and what to do, step by step

Status: proposal for approval. Nothing here is built yet.
Written for: the founder (not a developer). Plain language first. Estimates are rough guesses, not measurements, and will change.
Sources: the approved product brief (docs/designs/workspace-video-product-brief.md), the template plan (docs/architecture/template-driven-spaces.md), a read of the code, and a market check (competitor claims are self-reported and unverified).
Evidence words: **measured** = we ran it, **read** = seen in the code, **claimed** = a competitor's own statement, **guess** = my estimate.

---

## 1. The one-page answer

You are building a lightweight, global workspace where people sit in a shared space, click to jump to each other, hold instant video rooms by link, leave video or audio notes, and have AI turn every recording into summaries, to-dos and searchable memory. You chose to build the full platform **in sequence, where a real team uses each phase before the next one starts.** That rule protects you from the biggest risk of the full platform: a year of building with nobody using it.

**What you already have:** a spatial voice workspace engine, measured at 100 people (200 and 500 not measured with the latest fix), sign-in, workspaces, roles, invites and plan limits.

**What is missing, in order of how much it blocks you:**
1. Nothing runs on the internet yet, and there is no deploy pipeline, staging, error tracking or analytics.
2. No video and no screen share (the code forbids them today).
3. No recording, no video or audio notes, no AI.
4. No instant rooms with a link, and no guests without accounts.
5. No payments, and no real sign-in (only a dev sign-in).
6. Nobody outside your head has used it. **This is the biggest gap.**
7. Browser speed has never been measured, and speed is your edge.
8. One code-level security risk: public default secrets (decision F1).

---

## 2. Decisions made so far

| # | Decision | Chosen | Note |
|---|---|---|---|
| D2 | Version-1 approach | The full platform in sequence | I recommended a narrower start; gates added to manage the risk |
| D4 | Review mode | Scope expansion | |
| E1 | Missed-jump note | Added | Video or audio, sender's choice |
| E2 | Public speed benchmark | Added | |
| E3 | Interview mode | Added | After rooms, guests and recording |
| E4 | Integrations | Added, widened | One open API + webhooks + automation connectors, plus about five native ones |
| E5 | Ask the workspace (memory) | Added | |
| E6 | AI screening, portal API, post-meeting AI notes and to-dos | Added, widened | Human always decides; compliance built in |
| F1 | Default secrets | Fix in Phase 0 | Production refuses to start on defaults; split the two secrets |
| F2 | Hosting | **Self-host** | Against my recommendation. Needs an ops person and an infrastructure test with a go or no-go gate |
| F3 | Video in the office | Audio-only nearby; video on a click or in a room | |
| F4 | Recording rules | Consent banner always, participants and admins only, 90-day default retention, deletion on request | |
| F5 | Pricing | Per concurrent user plus paid AI and recording usage | Against my recommendation to wait; treat as a hypothesis to test |
| F6 | AI screening timing | After recording and summaries, legal review started early | |
| F7 | Regions | One region near the first pilot; measure others | |
| G1 | Engineering rules (sections 2 and 4 to 9) | Adopted as written | Recording-failure states, AI-summary validation, cost caps, error tracking, staging and rollback, tests |
| H1 | Bandwidth cost architecture | Cheap savers now (send less, encode less, CDN for stored and broadcast, meter); peer-to-peer and cross-region relay deferred until measured | Raised by the founder: F2 chose self-hosting but no cost-control design existed |

---

## 3. The phases

Each phase has a **gate**. You do not start the next phase until the gate is met. "Your job" is what only you can do.

### Phase 0: Make it real (about 2 to 3 weeks)
**Build:** rename the internal "cosmos" names; production refuses default secrets (F1); real sign-in to replace the dev sign-in; deploy to a real address with staging, automatic checks, error tracking; backups. (Product analytics and a feature-flag system were deferred to Phase 1 by the engineering review; see section 9.)
**Infrastructure test (F2, H1):** compare hosts on bandwidth terms (read the fair-use fine print, then measure), and on delay from each continent to real test devices. Run a video load test on the chosen host, measuring bandwidth per person per hour for audio-only, a 4-tile call and a 20-tile room. The results decide whether peer-to-peer or a cross-region relay is ever built. Check whether one room can span regions on the open-source media server (I believe it cannot; this is unverified).
**Your job:** decide the hosting budget; find and hire a person or contractor who watches servers; start the legal review of AI screening now (it takes weeks); decide the brand name and logo; do your three customer calls (see section 6).
**Gate:** a stranger signs up on www.workspace.video, reaches a room, a second person joins from another continent, and the delay numbers are written down.

### Phase 1: The fast office with video (about 6 to 8 weeks)
**Build:** the template plan slice (docs/architecture/template-driven-spaces.md sections 13 and 14): shared walkable rule, the 2.5D renderer with draw-on-change, three zoom levels, jump to anyone, the states and the quiet design system. Add camera and screen share under the F3 policy, a battery-saver mode, a "free to talk" status, and speed benchmark v1 (E2).
**Your job:** find the first pilot team (5 or more people) and watch them use it. Say nothing, take notes.
**Gate:** that team uses it on most working days for two weeks, and benchmark numbers are recorded against Cosmos's claims (10.4% CPU, 758 MB memory, both self-reported).

### Phase 2: Instant rooms and the first money (about 3 to 4 weeks)
**Build:** meeting, interview and board rooms opened by a link; guests without accounts; a waiting lobby; short-lived rooms; invite-to-talk; recording banner. Start the calendar app verification paperwork now (Google and Microsoft take weeks). Charge the pilot team (F5 hypothesis: per concurrent user).
**Your job:** ask the pilot team to pay, even a small amount, or to commit in writing.
**Gate:** someone outside the company joins by link in under 10 seconds, and the pilot pays or commits.

### Phase 3: Recording and notes (about 3 to 4 weeks)
**Build:** recording with the consent banner (F4), 90-day retention, playback, deletion on request; video or audio notes left on someone's desk (E1); transcripts.
**Gate:** 20 recordings or notes watched by real users; the cost per recorded hour is known.

### Phase 4: AI summaries and memory (about 4 to 5 weeks)
**Build:** summaries, action items, to-do lists and calendar entries after a recorded meeting; Ask the workspace (E5); AI quality tests; a hard cost cap per workspace.
**Gate:** users open the summary for more than half of recorded meetings, and the rate of wrong action items is measured and stated.

### Phase 5: Integrations (about 4 to 6 weeks)
**Build (E4):** one public API with keys, signed webhooks, an automation connector (so thousands of tools work at once), and about five native ones: calendar, Slack, Teams, a task tracker, company sign-in (SSO).
**Gate:** three real integrations in daily use by customers.

### Phase 6: Interview mode and AI screening (about 8 to 10 weeks)
**Build (E3, E6):** the legal review must be finished first. The candidate opens a link, sees a consent screen and a plain explanation, then takes an AI-led screening by video or voice. The employer gets a summary, a rubric and a shortlist; **a human decides, never an automatic rejection**. Bias tests, audit logs, opt-out, region rules. An API for job portals.
**Gate:** one company pilot, bias test results written down, lawyer sign-off recorded.

### Phase 7: The AI teammate in rooms (about 4 to 6 weeks)
**Build:** an AI participant that takes live notes, lists action items and answers questions, with clear consent and controls.
**Gate:** trusted enough that teams leave it on.

**Rough total: about 9 to 11 months, a guess.** The shape is firm; the numbers will move.

---

## 4. The review findings, condensed

### Architecture
```
 Browser (web app + canvas + LiveKit client)
    |  Socket.IO          |  WebRTC (audio, video, screen)       |  HTTPS
    v                     v                                      v
 Realtime server      LiveKit media server               Web/API: sign-in, rooms, guests,
 (exists, measured)   + recording service (NEW)          billing, screening, public API (NEW)
    |                     |                                      |
  Redis                   +--> Object storage <--> Job queue --> AI workers: transcribe,
                                                                  summarise, actions, index
                              Postgres (exists) + search index (NEW)
```
- What breaks first at scale: video bandwidth and cost, recording storage, AI cost per hour. The realtime engine is the part already measured.
- Single points of failure: one media server, one database, one Redis, one process per room.
- AI work runs in **separate workers**, never in the realtime process.

### Error and rescue map (nothing fails silently)
| Path | Failure | Required behaviour |
|---|---|---|
| Recording start | Fails mid-meeting | Visible "recording failed" state and a retry |
| Note upload | Connection drops | Resume; keep the local copy until confirmed |
| Transcription | Timeout, silence, wrong language | "Transcript unavailable"; recording stays playable |
| AI summary | Empty, refusal, malformed, invented items | Validate against a fixed shape, retry once, then show the transcript marked "summary unavailable" |
| Guest link | Expired or reused | Clear message and a way to request a new link |
| Camera or screen share | Permission denied | Say what to click; fall back to audio |
| AI spend | Cost cap hit | Stop and tell the admin |

### Security
- **F1 (critical, read in code):** [env.ts:22](../../apps/web/src/lib/env.ts) falls back to public default secrets in every environment. Fixed in Phase 0.
- New threats: guessable or leaked guest links; one company reading another's recordings; AI prompt injection through what people say in a meeting; scoped and rate-limited job-portal API keys; signed webhooks; candidate data protection.

### Compliance (from the market check; confirm with a lawyer)
AI candidate screening is regulated: EU AI Act high-risk, NYC Local Law 144 (annual bias audit, notice, opt-out), Illinois AI Video Interview Act (notice, explanation, written consent). Required in Phase 6: consent, plain explanation, human decides, bias testing, audit logs, opt-out, region rules.

### Edge cases that need a rule before build
Double-click on Record; leaving mid-upload; a 3-hour recording; a guest joining after the room ended; two people recording one room; a job that runs twice; a queue backing up for two hours; a deleted recipient; calendar time zones.

### Tests beyond the ordinary
AI quality tests (summary accuracy, invented action items, screening bias); video load tests (N people with cameras); chaos tests (kill the media server, kill a worker mid-job).

### Performance ("no CPU damage")
Small preview quality by default, few tiles on screen, a battery-saver mode, a published benchmark, a first-load size budget. The current canvas redraws every frame forever ([PixiStage.ts:194](../../apps/web/src/canvas/PixiStage.ts)); the template plan fixes that.

### Bandwidth cost architecture (decision H1)
Figures are arithmetic on assumed bitrates (a guess), to be replaced by Phase 0 measurements: audio only, 6 nearby people at 32 kbps is about 86 MB per person per hour (about 260 MB at 96 kbps); a 4-tile video call at a medium layer is about 900 MB per person per hour (about 2.7 GB at top 720p); a 100-person team with 1 hour of video a day is about 2 TB a month, and with video always on for 8 hours about 16 TB a month.

| Layer | What | When |
|---|---|---|
| 1. Send less | Audio-only nearby, video on a click or in a room (F3); cap video tiles at about 6; small tiles request small quality | Phase 1 |
| 2. Encode less | Turn on simulcast, dynacast and adaptive stream (already in LiveKit); audio default 32 to 48 kbps with silence suppression, higher quality as a paid option | Phase 1, verified in the Phase 0 load test |
| 3. Peer-to-peer | Good only for one-to-one calls; needs a second media path, no server-side recording or AI on those calls, and a relay is still needed for strict firewalls. Meshes of 4 or more people also hurt client CPU and battery | **Deferred**: revisit after measurement |
| 4. CDN | Stored recordings, video and audio notes, template art tiles, and large one-way events (HLS, about 8 to 12 seconds of delay). Not usable for live two-way calls | Phase 3 for stored items; broadcast when a large-event need appears |
| 5. Multi-node servers | Several media servers per region share the load. Cross-region relay is described as a LiveKit Cloud feature; on self-hosting, rooms are placed in one region (F7) or the relay is built by hand (large, unverified for the open-source server) | **Deferred**: decided after the Phase 0 numbers |
| 6. Meter and cap | Bandwidth meter per workspace, cost dashboard, soft limits, usage-based pricing (matches F5) | Phase 1 meter, Phase 2 limits |

Phase 0 must measure, per person per hour: audio-only, a 4-tile call, and a 20-tile room; the egress terms of each candidate host; and delay from each continent. Those numbers decide whether layers 3 and 5 are ever needed.

### Observability
Error tracking, product analytics (sign-up to second person joining), recording success rate, queue depth, AI cost per feature, and alerts on each.

### Deployment
Missing entirely today: staging, CI, feature switches, migrations with rollback, post-deploy checks. Phase 0 creates them.

### Trajectory
Hard to reverse: recording storage layout (2 of 5), pricing unit (4 of 5, but painful with customers), AI vendor (4 of 5 behind an adapter). The media and job pipeline is the platform: E1, E3, E5 and E6 all sit on it.

---

## 5. Not in scope (written down, so it is not forgotten)
- A template marketplace and the Template Studio (deferred in the template plan).
- A mobile app. A phone browser view is covered only by the design review's Pass 6, which is still open.
- Multiple regions from day one (F7). Measured in Phase 0.
- Invite links to meetings opened in a new window, like Zoom (this becomes Phase 2).

## 6. Your assignment this week
Talk to **three people who run or manage a remote team**. Ask only: what do you pay for today to talk, meet and share videos, and what annoys you most? Write down their exact words. Do not show them anything. Then talk to **two people who hire in volume** (a recruiter or talent lead), and ask how they screen 100 applicants today and what it costs. This is the evidence the pricing (F5) and the screening bet (E6) do not have yet.

## 7. What already exists (reused, not rebuilt)
Realtime spatial engine and proximity audio; LiveKit selective subscription; sign-in, workspaces, roles, invites and plan limits; the template plan and its design spec; the load harness and the profiling tools.

## 8. Open items
- The founder's own worst moment with current tools (the specific pain).
- Which pilot team, and who pays.
- Pricing, to be tested (F5).
- Brand name and logo, and replacing "cosmos" internal names.
- Design review Pass 6 (phones and accessibility) and Pass 7 (open decisions) of the template plan are not done.

---

## 9. Reviewed build plan: Phase 0 (engineering review)

Outcome of the engineering review of Phase 0. The secrets work is already done (commits `f344538`, `76dbd7e`, `189a42b`). Evidence words as above. Confidence scores and quoted lines are in the review conversation; the file and line references below are the motivating evidence.

### Decisions taken in the review
| # | Decision | Chosen |
|---|---|---|
| D2 | Phase 0 scope | Reduced: sign-in, one production stack, small staging, CI, error tracking, backups, infrastructure test. Product analytics and a feature-flag system deferred |
| 1A | Sign-in | **Better Auth** for the email link behind the current session seam (`getSessionUser`, `signRealtimeToken`), **gated by a one-day spike**; if the spike fails, fall back to a hand-written email link on the existing tables (pre-approved fallback). Dev sign-in stays, still 404 in production. Includes: an email transport interface with a console transport for dev and tests, a timeout and clear error on provider failure, expiring one-time links, rate limits per email and per address, no account enumeration |
| 1B | Media config | Production LiveKit config is **generated from secrets at deploy**; `livekit.yaml` stays dev-only. The deploy refuses the dev key and the localhost address ([livekit.yaml:7](../../livekit.yaml)) |
| 1C | Database | **Managed Postgres**, app box and database in the **same region** (each page load makes several queries in a row), one restore drill recorded before the gate. Video servers stay self-hosted (F2) |
| 1D | Deploy | CI builds images tagged by commit; a deploy script backs up the database, runs migrations, pulls, restarts, checks health; rollback redeploys the previous tag; **migrations must be backward-compatible for one version** |
| 1E | `/internal` routes | The proxy forwards only `/socket.io` and `/health`; `/internal/metrics` requires a secret token in production; `/internal/resolve-room` is **not registered in production** ([server.ts:55](../../apps/realtime/src/server.ts), [server.ts:199](../../apps/realtime/src/server.ts)). Tests prove each rule |
| 2A | Rename | **Everything, including the local database user, name and volumes.** Every existing local database and Codespace needs `docker compose down -v`, migrate and re-seed once |
| 2B | Duplicate helper | Move `required()` into the shared package, own small commit |
| 3A | CI and flaky tests | CI gates on **all** tests. On a failure it prints durations and attaches the report; nothing is retried or loosened until a failure report has been inspected |
| 3B | Infrastructure test | Scripted headless call clients in about four regions on **short-lived hourly rented machines destroyed after the run**; records round-trip time, jitter, packet loss, bytes; a validity check compares client bytes with server counters; one run per host, no changes from a result. **The host is the cheapest one that passes the measured limits** (assumed reading of "look for the cheapest one") |
| 3C | E2E level | Route-level integration tests in CI (real Postgres, test inbox) plus **one browser smoke test on staging** after each deploy |
| 4A | Speed baseline | One scripted, repeatable baseline (JavaScript size, load time of the real domain from two regions, idle CPU and memory of the canvas), numbers only, no thresholds |
| TODOs | Deferred with context in [TODOS.md](../../TODOS.md) | Analytics and feature flags; zero-downtime realtime deploys; cut live connections on revoke |

### Build order and parallel lanes
```
 Step 0 (alone, first):  T1 rename everything (structural commit)
         |
         +--> Lane A  apps/web, apps/realtime, packages/*   T2 -> T3 (spike gate) -> T4 ; T10
         +--> Lane B  Dockerfiles, .github/, deploy/        T5, T6, T7(deploy side), T12, T13
         +--> Lane C  scripts/ and rented test machines     T8, T9
         +--> Founder lane: hosts, DNS, email provider + SPF/DKIM/DMARC, managed Postgres, error tracking account, registry
```
Lane A and Lane B do not share a directory; both wait for T1 because image names and package names change in it. Lane C needs nothing from T1 except script paths.

### Implementation tasks
- [ ] **T1 (P1, human: ~1d / CC: ~1h)** Rename `@cosmos/*`, cookie, devcontainer, database user/name/volumes, and doc headings, in one structural commit. Verify: typecheck, full suites, a scripted check that no old name remains outside historical docs. Files: whole repo (98 files).
- [ ] **T2 (P1, ~2h / ~30min)** Regression tests first for existing untested behaviour: dev-signin 404 in production and flag off; `getSessionUser` cookie ok/none/bad; realtime-token 401 signed out and secret separation. Files: `apps/web/src/lib/__tests__`, `apps/web/src/app/api/auth`.
- [ ] **T3 (P1, ~2wk / ~2-3d)** One-day Better Auth spike (gate), then email-link sign-in per 1A with the tests in section 9 test plan. Files: `apps/web`, `packages/db/prisma`.
- [ ] **T4 (P1, ~1d / ~2h)** Protect `/internal` per 1E, with tests. Files: `apps/realtime/src/server.ts`, the proxy config.
- [ ] **T5 (P1, ~1d / ~2h)** Production LiveKit config generator plus a deploy check that refuses the dev key and localhost address (1B). Files: `deploy/`.
- [ ] **T6 (P1, ~1wk / ~1d)** Dockerfiles, CI (typecheck, tests, printed durations, fail when zero tests are found), images tagged by commit, deploy script with backup-before-migrate and rollback, staging from the same recipe (1D, 3A). Files: `.github/`, `deploy/`.
- [ ] **T7 (P1, ~1d / ~1h)** Managed Postgres in the same region as the app box; one restore drill recorded (1C).
- [ ] **T8 (P2, ~1wk / ~2d)** Infrastructure test scripts and one recorded run per candidate host (3B), including database round trip and TURN/TLS relay-only check.
- [ ] **T9 (P2, ~2d / ~3h)** Browser-side baseline script (4A).
- [ ] **T10 (P2, ~1h / ~10min)** Move `required()` to the shared package (2B).
- [ ] **T11 (P2, ~1d / ~2h)** Browser smoke test on staging after each deploy (3C).
- [ ] **T12 (P2, ~1d / ~2h)** Error tracking in web and realtime, with a deliberate error confirmed visible.
- [ ] **T13 (P2, ~2h / ~30min)** Alert when the last successful backup is older than about 26 hours.
- Founder tasks: choose hosts (cheapest that passes T8), set DNS, choose the email provider and add SPF, DKIM and DMARC records for workspace.video, open the managed-database, error-tracking and image-registry accounts.

### Test plan (coverage at review time: 3 of 33 paths tested)
Iron-rule regression tests are in T2. New sign-in tests (route level, in CI): request link for a valid and an invalid email; provider failure and timeout; rate limits per email and per address; the same reply for known and unknown email; verify a valid, expired, reused and tampered link; a link opened in another browser; a double click; revocation refuses the next request; sign-out; first-time user with no workspace creates one and reaches a room. Production guard: the built image starts with real values and refuses defaults. Deploy: dry run, backup-before-migrate order, rollback rehearsal on staging. Media: the config generator refuses the dev key; a relay-only client connects over TURN/TLS. Infrastructure test: the byte validity check.

### Failure modes (one per new path)
| Path | Failure | Test? | Handled? | User sees |
|---|---|---|---|---|
| Email provider | Down or slow | planned | timeout plus error state | "We couldn't send the link, try again" |
| Sign-in link | Reused, expired, tampered | planned | rejected | Clear message and a way to request a new link |
| Media server | UDP blocked | planned (relay-only client) | TURN/TLS fallback | Audio still works, or the existing audio error text |
| Deploy | Migration fails | planned (rehearsal) | backup first, deploy aborts, old version keeps running | Nothing |
| Backup | Job silently stops | planned (T13) | alert when stale | Nothing until alerted; **watch this one** |
| Error tracking | Outage | n/a | fire and forget | Nothing |
| `/internal` | Direct hit on the port | planned | token required, route absent | 401 or 404 |
| Infrastructure test | Measured nothing | planned (validity check) | run flagged invalid | Report says invalid |
No critical gap (no path is untested, unhandled and silent).

### Not in scope
- Product analytics and a feature-flag system (TODOS.md).
- Zero-downtime realtime deploys (TODOS.md).
- Disconnecting live connections on revoke or member removal (TODOS.md).
- Company sign-in (SSO) and Google or Microsoft sign-in: Phase 5.
- Multi-region, peer-to-peer, cross-region relay (decided after the infrastructure test).
- A full browser test suite; Kubernetes.

### What already exists (reused)
The session seam (`getSessionUser`, `signRealtimeToken`, [session.ts](../../apps/web/src/lib/session.ts)); the account, session and verification-token tables in [schema.prisma](../../packages/db/prisma/schema.prisma); the dev sign-in and its production 404; `prisma migrate deploy` in the Codespaces scripts; the secrets guard; the load harness and profiling tools (reused by T8).

### Unresolved decisions
None. Two assumptions to confirm: the reading of "look for the cheapest one" in 3B, and the new names for the packages (`@workspace-video/*`) and the database user and name.
