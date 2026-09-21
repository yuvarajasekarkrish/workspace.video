# Design system: workspace.video

The one place to look before building or changing a screen. Colours and typefaces are defined once, as tokens in [apps/web/src/app/globals.css](apps/web/src/app/globals.css); change them there, never inside a component.

Records decisions 5A (template design review) and D1, D4-D14 (landing and sign-in review, [docs/designs/landing-and-signin-design-review.md](docs/designs/landing-and-signin-design-review.md)).

## Look

Dark, calm, one accent. A tool people sit in all day, so the interface stays quiet and the space is the point. Cards only where the card itself is the thing you press (for example the plan choices). The signed-out landing page is the owner's Gemini design, ported as drawn ([docs/designs/gemini-landing.html.html](docs/designs/gemini-landing.html.html)): centred hero, grey-to-white gradient headline, Inter, and an interactive 2.5D map built from HTML and CSS. It uses blur and glow effects the rest of the app does not. Blur costs battery, so the page must not claim to be light on battery until it is measured. Its styles are in `apps/web/src/components/landing/landing.css` (classes prefixed `gl-`).

## Colour tokens

| Token | Value | Use |
|-------|-------|-----|
| `ground` | #0b0d12 | The page |
| `surface` | #14171f | Inputs and panels on the page |
| `line` | #343a47 | Borders |
| `fg` | #e6e8eb | Body text |
| `fg-muted` | #a9afba | Secondary text |
| `accent` | #2dd4bf | The one accent, a soft teal: primary buttons, the selected item, the highlighted headline words and your own dot in the room (label in `on-accent`, the dark ground colour). Chosen in the design review (D17) to replace amber |
| `link` | #5eead4 | Links and text buttons |
| `danger` | #f87171 | Error text |
| `accent-hover` | #14b8a6 | The accent button while the pointer is over it |
| `focus` | #93c5fd | Keyboard focus ring, caret |

Every text colour must reach 4.5:1 on `ground` and on `surface`; interface parts 3:1. A test enforces this ([designTokens.test.ts](apps/web/src/lib/__tests__/designTokens.test.ts)), so a new colour that fails breaks the build.

## Type

- **UI and headline face:** Inter (variable), self-hosted through `@fontsource-variable/inter`, chosen by the owner from the Gemini design. Set as `--font-sans`; `--font-display` points at it.
- **Number face:** IBM Plex Mono, for counts and timers (`.tabular`). Set as `--font-mono`.
- Either can be swapped by changing the token and the package import in `globals.css`.
- Body text is 16 px. Headings step up from there. Nothing reads smaller than 16 px on the pages in this system.

## Controls

- Inputs and buttons are at least 48 px tall and use 16 px text. (Phones zoom into fields under 16 px, and small buttons are missed.)
- Primary action: one `accent` button per screen. Secondary: text in `link` or a bordered button.
- Every control shows the themed focus ring, and works by keyboard.
- Errors and status messages are announced to screen readers (`role="alert"` for errors, a polite status for waiting).

## Motion

- Reduced motion is respected globally (see `globals.css`); anything that loops or autoplays must stop under it.
- Timers and animation loops start when there is work and stop themselves (no permanently running timers).

## Open

- **Ground and surface do not match the code yet.** This table says `ground` #0b0d12 and `surface` #14171f, but `globals.css` (changed by the landing page port) uses #0a0a0a and #171717, and the room page uses #0b0d12 in one place and the canvas #0a0a0a. The owner has said the live room follows this file strictly, so one set must be chosen and the other made to match. Waiting for the owner.
- **Status dots use amber.** The "connecting" dot and the "nearly full" occupancy text use the standard amber (Tailwind `amber-400`). They mean a state, not the accent, and the owner has not yet said whether "no amber anywhere" covers them.

- The room screen (canvas, heads-up display) still uses its own colours and sizes; it moves onto these tokens in a later pass.
