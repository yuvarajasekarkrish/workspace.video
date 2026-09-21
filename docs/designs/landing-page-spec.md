# Landing page and sign-in: the owner's spec (2026-09-21)

Written for: the product owner first, then whoever builds and tests these pages.

Source: the owner went through a reference site's home screen, sign-in page and footer element by element and decided each one in their own words. This document records those decisions. It replaces the earlier draft order in `landing-and-signin-design-review.md` where the two disagree. Nothing here was chosen by the reviewer.

## The look (decided earlier, still standing)

Dark and spatial: deep ink ground, the product as the hero, one warm amber accent, a display face for headlines (Bricolage Grotesque) and Instrument Sans for the interface. Tokens live in `apps/web/src/app/globals.css`; the rules are in `DESIGN.md`.

## First screen, element by element

| # | Element | Decision |
|---|---------|----------|
| 1 | Top bar | Logo + "workspace.video" on the left (today a placeholder mark). Links in the middle: **Product, Use cases, Pricing**. On the right: **Request a Demo**, **Log in**, and one main button **Get started**. No "Meetings" or instant-links item until those are built. |
| 1d | Request a Demo | **Now:** a booking page (Cal.com) using the team's availability; a live chat bubble; a recorded 2-minute tour. **Later, once guests can join by link:** a live demo room in workspace.video, and a "We're online now" indicator that turns "Book a demo" into "Join now". |
| 2 | Announcement pill | "What's new", linking to a changelog page. Needs the changelog page and one real recent update. |
| 3 | Headline | **Remote teams that feel like a team.** The words "feel like a team" are solid amber (no gradient). |
| 4 | Supporting line | **A virtual office you walk around in.** |
| 5 | Actions | Email box + "Get started", with "Request a Demo" beside it. |
| 6 | Reassurance line | None. (Remove the "No password…" line under the form.) |
| 7 | Proof | Measured server fact (100 people in one space, stated with what it means); space for pilot teams' logos or a quote, added only with their permission; and an **In development** section (below). No invented reviews, awards or customers. |
| 8 | Background | Plain deep ink. Nothing else. |
| 9 | Picture | Drawn in 2.5D, peeking above the fold and cut off at the bottom. Drawn in code from the app's own look; replaced by a real capture later. |

## "In development" section (the owner's edge)

The owner requires the edge on the front page: 2.5D rendering, light on battery, instant load, and template screenshots. What is true today (from `template-driven-spaces.md` and the code):

- The canvas redraws every frame even when nothing moves (`PixiStage.ts`, permanent ticker, anti-aliasing on, no idle mode), so **it is not yet light on battery**.
- 2.5D rendering and template art are **not built** (the S0-S8 slice has not started).
- **No browser speed numbers exist** (task T9, the browser baseline, has not run).

Decision: an **In development** section now, no numbers and no template screenshots, with empty labelled frames "Template preview coming". When the light-rendering work and the baseline exist, replace it with measured numbers and real pictures. The page never claims low battery drain or instant load before they are measured.

## Sign-in page

| # | Element | Decision |
|---|---------|----------|
| 10 | Ways to sign in | **Email link, Google, Microsoft, and company single sign-on (later).** Email link exists today. Google and Microsoft need the owner to create the login setup in each portal and put the two keys into the server settings (never in chat). Single sign-on is a later phase. |
| 10b | Company sign-in link | A company (for example a consultancy that bought 10 concurrent users) gets its own link. Opening it shows the company's logo or name; people sign in with their company email. **Both** ways in: anyone with an email on the company's domain, and invited outside guests. Billing follows people present at the same time; the admin can add a person (billed from the next recurring month) and create spaces; a guest can join for a short time (about 20 minutes) for a meeting or call. **None of this is built.** |
| 11 | Legal | A line under the email box: "By continuing you accept our Terms and Privacy Policy", both linked. The reviewer writes plain-language **drafts** of both pages; a lawyer must review them before real users sign up. Drafts are not legal advice. |

## Footer

Brand column with logo and social icons; **Product** links (Product, Use cases, Pricing, FAQ, Changelog); **Legal** (Terms, Privacy, Cookie policy if cookies are used); **Contact** (a contact email and the booking page); **Social** icons (need the accounts to exist). The comparison columns ("vs Zoom", "vs Gather", and so on) are **added later, when the product has video and rooms**. Every footer link must lead to a real page; nothing links to a page that does not exist.

## Still open (needs the owner)

1. The logo (a placeholder mark is used until then).
2. A Cal.com account and its booking link; the choice of chat widget vendor.
3. The recorded 2-minute tour (it can double as the hero clip).
4. The wording of the Pricing section: pay for people present at the same time; the admin can add people from the next monthly bill; guests for short calls. Confirm or edit.
5. A contact email address and the social accounts to link.
6. A lawyer to review the Terms and Privacy drafts.
7. The first "What's new" entry for the changelog.
8. Google and Microsoft login setup (when sign-in with them is built).

## Later phases this spec creates (nothing built)

- Light rendering and 2.5D template rendering, then the browser baseline (T9), then real numbers and template pictures on the page.
- Guest links (short-lived), the live demo room, and the "We're online now" indicator.
- The company sign-in link: branding, email-domain rule, invited guests, per-company concurrent-user billing, admin controls.
- Comparison pages against other products, when the product has video and rooms; each honest, dated and sourced, and lawyer-reviewed.
- Single sign-on for company accounts.

## Build order (proposed)

1. First screen: top bar, headline, support line, email box with the demo button, the drawn 2.5D picture (elements 1-9).
2. The sections below it: How it feels, Use cases, the In development section, Pricing, FAQ, closing call to action, footer.
3. The pages behind links: changelog, Terms and Privacy drafts, contact.
4. Sign-in page changes: the legal line now; Google and Microsoft when the owner has the setup.

## Update: the owner's Gemini design replaces the landing page (2026-09-21)

The owner supplied a design made with Gemini (`gemini-landing.html.html`, next to this file) and asked for it to be used as drawn, replacing the page built from the element-by-element decisions above. The landing page is now that design: five screens (home, the 2.5D map with its admin builder, an instant space, pricing, sign in), Inter, the gradient headline, Gemini's words and colours. Two real parts were added: the email sign-in box (home and sign-in screens) and the Terms and Privacy line. The owner will change the content later.

Words in the design that are not true today, kept on the owner's instruction: "up to 200 users per workspace", the Admin Drag and Drop Builder, Instant Space and its video screen, and the "online" count. Not built: the "In development" section, FAQ, footer, Request a Demo, and the What's new pill (the changelog, Terms and Privacy pages still exist). Everything else in this file describes the earlier page and is superseded where it disagrees.

## Build status (2026-09-21, local only, not yet pushed)

Built to this spec: the top bar (with a phone menu), the What's new pill and /changelog, the headline and support line, the email box with "Get started" and the Terms and Privacy line, the drawn 2.5D scene (peeking, faded at the bottom), How it feels, Use cases (stacked), In development, Pricing, FAQ, closing call to action, the footer, and draft /terms and /privacy pages. The page title, description, link preview text and icon are fixed. Guarded by 361 passing tests.

Switched on by configuration, and not drawn until set (so nothing is a dead link): `DEMO_URL` (Request a Demo), `CONTACT_EMAIL`, `SOCIAL_X_URL`, `SOCIAL_INSTAGRAM_URL`, `SOCIAL_LINKEDIN_URL`. Not built: the live chat bubble, the recorded tour, Google and Microsoft sign-in, the company sign-in link.

Choices made by the builder, for the owner to confirm or change:
1. Under the drawn scene: "Concept illustration. The real space is on the way." (the scene is tilted 2.5D, today's room is flat).
2. Three empty template frames, named Island campus, Plain office, Small buildings.
3. The What's new pill text: "sign in with an email link" (the one real recent update).
4. Pricing wording: pay for people online at the same time plus usage; an added person is on the next monthly bill; guest passes for about 20 minutes are marked as coming.
5. The terms and privacy drafts, with every undecided item in square brackets ("to confirm").
6. A placeholder logo mark (an amber tile with a dot) until a real logo exists.
7. Rules from the taste review kept in the code and tests: one label ("Get started"), no dots or numbering, no three-column grid, no em dashes, no reviews or awards, no measured claims about battery or speed.
