# TODOs

Deferred work, with enough context to pick it up later. Each item came from a reviewed decision.

## Product analytics and a feature-flag system
- **What:** add product analytics (sign-up to second person joining, feature use) and a switchable-feature system.
- **Why:** analytics shows whether the first pilot team really uses the product; switches turn a risky feature off without a deploy.
- **Pros:** real usage numbers, safer releases.
- **Cons:** two more services to run and pay for; analytics with no users measures nothing.
- **Context:** deferred from Phase 0 by the engineering review (decision D2, docs/architecture/workspace-video-roadmap.md section 9). Feature switches are plain settings for now.
- **Trigger:** start when the first pilot team starts, in Phase 1.
- **Depends on:** a first real team; the hosting decision (self-hosted analytics or a service).
- **Priority:** P2.

## Zero-downtime realtime deploys
- **What:** let a deploy replace the realtime server without dropping everyone's connection.
- **Why:** the realtime server is one process. A deploy restarts it and every person is disconnected for a few seconds. The client reconnects, so this is acceptable for pilots if deploys happen in quiet hours.
- **Pros:** deploys during working hours with nobody noticing.
- **Cons:** needs a second instance and room hand-off; room ownership is sticky, so hand-off is real engineering.
- **Context:** found in the Phase 0 architecture review. Not a Phase 0 blocker.
- **Trigger:** a customer objects to deploy-time drops, or there is more than one pilot team.
- **Depends on:** the deploy pipeline (1D) and measured reconnect behaviour under load.
- **Priority:** P3.

## Cut live connections when a session is revoked or a member is removed
- **What:** when someone signs out everywhere or is removed from a workspace, disconnect their live socket and remove them from the call at once.
- **Why:** the socket token and the call token each last one hour (apps/web/src/lib/session.ts:24, apps/web/src/lib/livekit.ts:26) and a connection is only checked when it opens, so a removed person can stay connected until they close the tab. Better Auth revocation (decision 1A) stops new sign-ins, not existing connections.
- **Pros:** offboarding that actually cuts access, which company buyers ask about.
- **Cons:** needs a disconnect message from the web app to the realtime server and a call to remove the person from the media room.
- **Context:** no member-removal or sign-out-everywhere feature exists yet, so nothing is exposed today. It becomes real the day either is built.
- **Trigger:** before member removal or sign-out-everywhere ships.
- **Depends on:** the Better Auth session work (1A) and the protected internal route (1E).
- **Priority:** P2.
