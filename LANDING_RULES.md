# Rules for this round of landing page work

Written before touching any code, per the owner's standing instruction (see `RULES.md` rule 4a):
every approved decision becomes a written rule before work starts, not just acted on once.

## Scope — what this round is, and is not

1. **Landing page only.** `apps/web/src/components/landing/LandingPage.tsx`,
   `apps/web/src/components/landing/landing.css`, and `apps/web/src/components/SignInForm.tsx`
   (used only by the landing page). Nothing else.
2. **Colour and copy only — no architecture.** No new state, no new routes, no new rendering logic,
   no changes to `MapScreen`, the admin builder panel's behaviour, or how sign-in actually works.
   If a button's destination changes, it's a link/href change, never new logic.
3. **No new sections.** The hero's own two buttons (`Explore the 200-User Map`, `Open Admin
   Builder`) stay exactly where they are, just recoloured. Nothing is moved to a new "features"
   area in this round.
4. **Global design tokens (`apps/web/src/app/globals.css`) are not touched.** `accent` stays amber
   there for the rest of the app (this is the room canvas's separate, already-established palette
   plus the shared token file — out of scope). This round overrides colour only inside the three
   files listed in rule 1, so nothing outside the landing page changes shade.

## The palette for this round

5. **Strict monochrome: black, graphite, white. No amber anywhere on this page.** Every current
   `accent`/`amber` use in the three files above (buttons, the pill dot, the admin panel border and
   heading, avatar circles, sign-in button, Terms/Privacy links) becomes a black/graphite/white
   equivalent instead.
6. **Only colour changes, not typography, spacing, or copy** — except the one head change in rule 8.
   Headline and support-line wording stay exactly as drawn (owner's earlier decision, still standing).

## The head (nav), as already decided

7. **Nav becomes: Demo, Pricing, Instant Space — Sign In, Create workspace.**
   - "Spatial Map" is renamed to **Demo**. Same destination, same behaviour, label only.
   - "Instant Space" is unchanged.
   - "Admin Builder" is renamed to **Create workspace** and becomes a real link: sign in with
     `next=/workspaces/new`, landing in the genuine create-workspace form after the emailed link is
     opened. Not a mockup destination.
8. **"Launch Workspace" is removed.** It called the exact same function as "Spatial Map"/"Demo" —
   confirmed in code, a literal duplicate, not a design opinion. Removing repeated content, not new
   content.

## Process

9. **Not committed, not pushed.** This stays as an uncommitted, local-only change until the owner
   says otherwise. Revert at any time with `git restore` on the three touched files, or `git stash`
   for the whole working tree — nothing here is permanent until asked for.
