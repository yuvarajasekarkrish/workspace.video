# Landing page, sign-in and home: design review (2026-09-21)

Written for: the product owner first, then whoever builds and tests these pages.

Scope: the signed-out first screen (today a bare sign-in form), the sign-in journey added on 2026-09-21 (email link through Resend), and the signed-in home page. The designer tool had no key, so this review works from the code and text layouts, not mockups.

Score: **3/10 before, 7/10 after these decisions are built** (the lowest of the six passes). The rest of the score depends on content only the owner can supply (see "Still open").

## What is decided

| # | Decision | Chosen |
|---|----------|--------|
| D1 | A link that was already used or has expired | Show a clear message above the form: "That link has expired or was already used. Enter your email to get a new one." Screen readers announce it. |
| D4 | What a stranger sees first | A real landing page before sign-in, not only a form |
| D5 | Main picture | A 10-second silent looping screen recording. It must pause under a reduced-motion setting, and the page makes sense before it loads. |
| D6 | Where sign-in lives | The email box sits in the first screen next to the headline. All states (sending, check your email, link expired, errors) stay on the same page. |
| D7 | Email never arrives | On "Check your email": a spam hint plus a "Send it again" button, greyed for about 30 seconds, keeping the person's address, showing the server's limit message when the cap of 3 requests per 10 minutes is reached |
| D8 | A new person with no workspace | A welcome: "You're not in a workspace yet." with one primary button "Create your workspace" and "Been invited? Open the invite link you were sent." Replaces the developer wording about the seed script. |
| D9 | Invite opened while signed out | After the emailed link, the person lands back in the room they were invited to, not on the home page. Only addresses on this site are accepted as the return address. |
| D10 | Signed in but not a member of a room | A plain "no access" screen: says who they are signed in as, suggests signing out and using the invited address, buttons "Sign out" and "Go to my workspaces". It does not reveal whether the room exists. |
| D11 | Below the first screen | The full page: pricing, FAQ, use cases. (The reviewer recommended a shorter page; the owner chose the full one.) No invented prices, testimonials or customer names: a section with no real content waits. |
| D12 | Phones | Inputs 16 px (so iPhone Safari does not zoom), buttons at least 48 px tall and full width, 16 px side margin, the email box above the clip, the clip loads after the form |
| D13 | Accessibility | Body text 16 px and at least 4.5:1 contrast (the grey used for "No workspaces yet" is about 4.1:1 and fails), a visible themed focus ring, everything usable by keyboard, messages announced to screen readers, the resend countdown announced in words |
| D14 | Addresses | Same address (/): the landing page when signed out, the workspace list when signed in |
| 5A | Design system (decided earlier, in the template review) | A small token set, a one-page DESIGN.md, and a real font pair swappable in one place. Applies here too. |

## Journey (what the person feels, step by step)

| Step | Person does | Feels | Covered by |
|------|-------------|-------|-----------|
| 1 | Opens an invite link, signed out | Curious, a bit wary | D4-D6, D9 |
| 2 | Sees the first screen | "What is this?" | D4, D5, D6 |
| 3 | Types email, taps the button | Hopeful | D12 |
| 4 | Sees "Check your email" | Waiting | D7 |
| 5 | Opens the email, taps the link | Expects to be inside | D9 |
| 6 | Arrives | Should be in the room | D9 |
| 7 | Link already used or expired | Confused | D1 |
| 8 | Not allowed into the room | Rejected | D10 |
| 9 | First time, no workspace | Lost | D8 |

## States of the sign-in surface

| State | What the person sees |
|-------|----------------------|
| Idle | Form, button "Email me a link" |
| Sending | Button says "Sending..." and is disabled |
| Sent | "Check your email", their address, 15-minute note, spam hint, resend after a short wait (D7) |
| Invalid email | "Enter a valid email address." |
| Too many requests | The server's own message |
| Send failed | The server's own message |
| Network down | "Couldn't reach the server. Check your connection and try again." |
| Link used or expired | Message above the form (D1) |

## Still open (needs the owner, not a design choice)

1. The headline and one-sentence promise, in the owner's words.
2. Pricing, FAQ answers and use cases (pricing follows decision F5: per concurrent user plus usage).
3. The font pair (decision 5A says it can be swapped in one line later).
4. Who records the 10-second clip, and when. Until then the page ships with a still frame.
5. Whether room invite links exist yet and what they look like. D9 needs a return address to hand back.

## Not in scope

- Visual mockups (the design tool needs an OpenAI key that is not set up).
- Pricing numbers and customer quotes (not available yet).
- A separate marketing site at a different address (D14 keeps one address).
- Changes to the room itself, the canvas, and the in-room HUD (covered by the template design review).

## What already exists and is reused

- The sign-in form, its states and its tests (`SignInForm.tsx`).
- The same-site check on the sign-in return address (`handleAuthRequest.ts`), which D9 relies on.
- The dark ground `#0b0d12`, Tailwind, and the dev sign-in form (development only).
- Decision 5A from the template review.

## Build tasks (in order)

- [ ] **T1 (P1)** Return to the invited room after sign-in (D9). Files: `SignInForm.tsx`, `app/room/[roomId]/page.tsx`, the sign-in request. Verify: test that a room link opened signed out ends in that room after sign-in, and that an address on another site is refused.
- [ ] **T2 (P1)** Used-link and expired-link message (D1). Files: `SignInForm.tsx`, `app/page.tsx`. Verify: component test with `?error=INVALID_TOKEN` and `EXPIRED_TOKEN`.
- [ ] **T3 (P1)** "Check your email": spam hint and resend after a wait (D7). Verify: test the wait and the limit message.
- [ ] **T4 (P1)** Welcome state for a new person (D8) and the no-access screen (D10).
- [ ] **T5 (P2)** Design tokens, `DESIGN.md`, real font pair, themed focus ring (5A, D13).
- [ ] **T6 (P2)** Phone and accessibility rules on the form (D12, D13).
- [ ] **T7 (P2)** Landing page first screen with the email box and the clip (D4-D6, D14). Needs open items 1 and 4.
- [ ] **T8 (P3)** The remaining landing sections: pricing, FAQ, use cases (D11). Needs open item 2.
