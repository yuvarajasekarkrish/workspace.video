# Tomorrow's plan (2026-09-22): what is pending, in the order that is easiest to finish and check

Written for: the product owner. Plain words first.
How it was ordered (the owner's rule): **not by priority**. By how easy and quick each task is to finish, and how clearly it can be checked. Small, safe, checkable tasks come first; the big ones come last, and they are only started if time is left.
Times are Claude's working time, rough guesses, not measurements. "Check" means what we look at to know the task is really done.

## The order, and why

```
 SAVE WHAT EXISTS (all easy, all already tested)
   1 tidy loose files ─▶ 2 audio fix ─▶ 3 public-links settings ─▶ 4 legal pages ─▶ 5 landing + sign-in + design notes
                                                                                           │
 SMALL FIXES TO THE ROOM                                                                    ▼
   6 phone-friendly bar, 48 px buttons ─▶ 7 keep the map fitted on resize
                                                                                           │
 THE COLOUR CHANGE (two steps, never together)                                             ▼
   8 put every colour in one place (no visible change) ─▶ 9 switch amber to teal #2dd4bf
                                                                                           │
 BIGGER, ONLY IF TIME IS LEFT                                                              ▼
   10 room overlays onto DESIGN.md ─▶ 11 map text rule ─▶ 12 first build piece: plan rule + record table
                                                                                           │
   13 end of day: shut down and clean up (only when you say "done")
```

Rules that keep it safe: a task that only tidies (8) is its own save, before the task that changes how things look (9); the landing page is saved (5) before the colour change (9) because it contains amber; every task ends with its check and a save to GitHub; after any change to `PixiStage.ts` we look at the real room ("Connected", the dot moves when clicked, the map shows).

## The tasks

| # | Task | Why it is easy | Claude time | Check (what we look at) | Needs you? |
|---|---|---|---|---|---|
| 1 | Delete the 23 screenshots I left in the project's top folder and stop the browser tool's folder from showing up as unsaved | They are my own throw-away pictures, all unsaved and unused | 5 min | The list of unsaved files no longer shows any `.png` or `.playwright-mcp`; nothing that was saved is removed | No |
| 2 | Save the audio fix already in the unsaved changes (`livekit.yaml`, the voice server now advertises the address a browser on this PC can reach) | One small change, its reason is written next to it, and audio already connected with it | 5 min | The room's microphone button leaves "connecting" (it turned amber in my last check); saved on its own with the note that a real deployment needs the machine's real address there | No |
| 3 | Save the optional public-links settings (`DEMO_URL`, `CONTACT_EMAIL`, social links) with their code and two test files | Already written and tested; a link with no address simply is not shown | 10 min | `publicLinks` and `siteMetadata` tests pass; `env.example` shows names only, no real secrets | No |
| 4 | Save the Privacy, Terms and Changelog pages | Already written and tested | 10 min | The page test passes; I open `/privacy`, `/terms`, `/changelog` in the browser and each loads with its heading | No |
| 5 | Save the landing page, the sign-in changes and the design notes (`DESIGN.md`, `globals.css`, `layout.tsx`, the font swap and its lock file, `icon.svg`) | Already written; all 433 web tests and the type check passed today | 25 min | Full test run and type check again; `pnpm install` from the lock file works; I look at the home page and sign-in in the browser at laptop and phone width | No |
| 6 | Bar under the map: 48 px buttons (your rule) and, below 640 px wide, show only microphone, find people and leave (decision 1A); zoom buttons also 48 px | Two class changes and one test; the exact problem is measured (436 px needed, 390 px available) | 30 min | Measure at 390 and 1280 wide: nothing cut off, no overlap, the bar's content width fits; component tests updated | No |
| 7 | Keep the whole map fitted when the window is resized, unless the person has zoomed or moved it themselves | Small; the fit maths and the "fit" button already exist | 40 min | A new test for "still fitted vs. changed by the person"; in the browser, resize the window and the map re-fits; the "Connected" check | No |
| 8 | Put every canvas colour in one file (`canvas/palette.ts`). Today the same amber is copied in `Avatar.ts:8`, `FloorView.ts:15`, `SeatOverlay.ts:7` and `ObjectView.ts:5` | A pure tidy-up: it changes no colour | 30 min | The room looks pixel-identical in before and after screenshots; a new test fails if a canvas file defines its own colour; all tests pass | No |
| 9 | Switch the one accent from amber to soft teal `#2dd4bf` (your decision in D17): `DESIGN.md`, `globals.css` tokens, the colour test, the landing page, sign-in, `icon.svg` and the palette file from task 8 | One value in the palette file plus the CSS tokens; a test already checks readability | 60 min | The colour test passes (text on the dark ground at least 4.5 to 1); no amber value is left anywhere (a search finds none); I look at home, sign-in, the room and the bar; you see the pictures | Yes: a quick look at the pictures |
| 10 | Move the room's overlay panels (connection badge, "in this room", area chip, toasts, note buttons) onto the `DESIGN.md` colours and sizes: 16 px text, 48 px controls | Mechanical, but it touches about 8 files | 90 min | Component tests; screenshots at laptop and phone width; nothing overlaps at 390 wide | No |
| 11 | Map text rule (decision 5B): area names always 16 px on screen; a person's name only for you, people near you, the person under the mouse and anyone found by search | New behaviour in the drawing code, so slower to check | 150 min | Browser check at the "fit whole map" view (readable, uncluttered) and at zoom; the resting-canvas measurement is repeated (0 frames idle); the "Connected" check | No |
| 12 | First build piece of the map builder (D16): the "more than 10 people" plan rule, the plan column in the who-may-do-what test table, and the record table for role and publish changes | No screen; pure rules and tests; the role rules already exist to copy | 120 min | One test per cell of role x plan x action; a refused save writes no record; the database change is additive and tested against the real test database | No |
| 13 | End of day: stop the web and realtime servers and reset the test room to how it started | Only when you say "done" | 10 min | Ports 3000 and 4001 no longer answer; the test room's settings are back to empty | Yes: you say "done" |

A realistic day reaches task 10. Tasks 11 and 12 are a stretch. Nothing later depends on them.

## Things only you can decide or do (none blocks tasks 1 to 10)

- **Status colours (green live, red away, blue focus, yellow idle):** confirm what each one means (proposed in D14), and approve adding a status to what the realtime server sends about each person. Until then the "set status" button stays switched off.
- **Camera, screen share, emoji, invite to talk:** they need new server messages or new features; they stay greyed out until you decide each one.
- **The 200-person server run and the memory-growth check:** they need you to run steps on the cloud machine; I will write them as click-by-click steps when you want them.
- **Three tool folders sitting unsaved in the project** (`.agents`, `.claude`, `skills-lock.json`): my suggestion is to leave them alone for now. Say if you want them saved or hidden.

## Not in this plan (and why)

Camera and screen share (no support in the app yet); emoji, status and "invite to talk" (server change needs your approval); the full drag builder, the set-up-from-needs screen and the template picker (large; D16 and D17 hold their specs); assigned desks (you said no); private draft walk-through (you said no).

## What already exists and is reused

The colour-contrast test, the fit maths and the "fit" button, the room's screenshots-and-measure method, the role rules (for task 12), and the plan lookup for the participant limit.

## Failure modes, one per risky task

| Task | What could go wrong | How it is caught |
|---|---|---|
| 5 | The font swap or lock file makes a fresh install fail | `pnpm install` from the lock file is run before the save |
| 5 | An address or secret slips into `env.example` | I read the diff; names only |
| 6 | The bar still overflows on some phone width | Measured at 360, 390 and 430 |
| 7 | The map jumps back while someone is zooming | A test for "changed by the person"; browser check while zooming |
| 8 | A colour changes without anyone noticing | Before and after screenshots compared; a test that no canvas file has its own colour |
| 9 | Teal text is hard to read somewhere | The colour test, plus my look at every screen |
| 11 | Many people's names clutter or slow the map | Browser check with the busy test room; repeat the 0-frames-idle measurement |
| 12 | A plan check lives only in the screen | The check is on the server and tested by calling the route directly |

## Test plan (what the checks are)

```
 CODE / SCREEN                   CHECK
 tidy files (1)                  git status
 audio fix (2)                   browser: microphone leaves "connecting"
 links, legal, landing (3-5)     existing tests, type check, install from lock file, browser look at 5 pages
 bar + zoom (6)                  component tests + measurement at 360/390/430/1280 wide
 refit on resize (7)             new unit test + browser resize + "Connected" check
 palette file (8)                new test (no colour outside the file) + before/after screenshots identical
 teal (9)                        colour test + search finds no amber + screenshots
 overlays (10)                   component tests + screenshots at 390 and 1280
 map text (11)                   browser at fit and zoom + 0 frames idle + "Connected"
 plan rule (12)                  role x plan x action table, one test per cell + real database test
```

## Review report (engineering review of this plan)

| Run | Status | Findings |
|---|---|---|
| Scope check | Done | Small tasks first; 13 tasks, of which 10 are a normal day |
| Architecture | 1 issue | The same amber is copied in four canvas files (confidence 9/10, quoted above); fixed by task 8 before task 9 |
| Code quality | 1 issue | `DESIGN.md` says `#f2b35a`, `globals.css` says `#f5a623`, `icon.svg` says `#f2b35a`; task 9 makes them one value |
| Tests | 1 issue | Nothing checks canvas colours; task 8 adds that test |
| Performance | No issues | Task 11 repeats the resting-canvas measurement |
| Owner decision | 1 asked, answered | Phone bar: show only what works below 640 px (1A) |

VERDICT: PLAN READY. OUTSIDE COVERAGE: not run (no second reviewer available); that is missing coverage, not a clean result.

NO UNRESOLVED DECISIONS

## Progress (written at the end of the working session)

| # | Task | State |
|---|---|---|
| 1 | Tidy loose files | Done (`e93d501`) |
| 2 | Save the audio fix | Done (`9661027`); audio connects about 8 to 10 seconds after the page opens |
| 3 | Public-links settings | Done (`1612412`), 6 tests |
| 4 | Privacy, Terms, Changelog pages | Done (`a71b471`), 7 tests, checked in the browser |
| 5 | Landing page, sign-in, design notes | Done (`095a3e6`), fresh install and 53 focused tests pass, checked signed-out at laptop and phone width |
| 6 | Phone-friendly bar, 48 px buttons | Done (`4d99231`), measured at 360, 390, 430 and 1280 |
| 7 | Re-fit the map on resize unless the person moved it | Done (`5214f44`), 5 new tests and a browser check |
| 8 | Every canvas colour in one file | Done (`9a59989`), before and after screenshots identical |
| 9 | Soft teal `#2dd4bf` replaces amber | Done (`b10aa29`), a test now fails if an amber value returns; pictures in `docs/designs/teal-accent/` |
| 10 | Overlay panels onto `DESIGN.md` | Done (`32ccb6c`), 41 rule tests; on a phone the note toolbar and people list are hidden (see below) |
| 12 | Plan rule (half) | Done (`8aa1cbb`): plans above 10 people only, on the server, after the role, downgrade keeps map and history. **Not done: the record table for role and publish changes (decision 3A).** |
| 11 | Map text rule (16 px labels, names only where useful) | Not started |
| 13 | End of day: stop servers, reset the test room | Waiting for you to say "done" |

Every save is on GitHub. The whole web suite (489 tests), the database tests (40) and the shared tests (167) pass.

### Things I found that need your answer

1. **Ground and surface colours.** `DESIGN.md` says `#0b0d12` and `#14171f`; `globals.css` and the canvas use `#0a0a0a` and `#171717`. The room now uses the tokens for its panels and page, so a single edit in `globals.css` will fix it once you pick one set. `DESIGN.md` records this under "Open".
2. **Status dots are still amber.** The "Connecting" dot and the "nearly full" occupancy text use the standard amber. They mean a state, not the accent. Does "no amber anywhere" cover them?
3. **The landing page announces "Admin Drag & Drop Builder"** and has "Open Admin Builder" buttons, but the builder is not built yet (and, by your rule, will not exist for the smallest plan). Public wording about an unbuilt feature is a promise worth deciding on.
4. **On a phone I now hide the "+ Note / Shape / Zone / Image" buttons and the people list.** They covered the area chip. Notes already on the map still show. Tell me if you want them back on phones in some other form.
5. **Joining the room takes about 5 seconds in the development server.** It is the first load of the page, not the room itself, but a real deployment should be measured.
6. **Three tool folders are still unsaved** (`.agents`, `.claude`, `skills-lock.json`) and `docs/architecture/eng-review-2026-09-19.md`. I left them alone.
