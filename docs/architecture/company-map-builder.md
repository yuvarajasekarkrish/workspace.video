# Company map builder: how sign-up, the admin panel, the map, seats and coordinates fit together

Status: decided by the reviewer on the owner's instruction ("you need to decide"), 2026-09-21. Nothing here is built except where it says so. The realtime engine (movement rules, proximity, batching) and the overall architecture are not changed by any decision below.
Written for: the product owner first, then whoever builds and tests it.
Evidence rule: **measured** = we ran it; **proposed** = a design choice; **to test** = must be measured before relying on it.

## The product flow (the owner's words)

A new user signs up. An admin panel lets them create their space. Once it exists the workspace is live: they can drag and create their own map, or use one we already have. Their teammates sign in and walk around it.

```
 sign up (email link, exists)
      |
      v
 create workspace  --------------------------------------------+
   name + plan; the creator becomes owner                       |  exists today:
   first room made in the same step, from a STARTER MAP         |  POST /api/workspaces
      |                                                         |  (one transaction)
      v                                                         +
 admin panel (owner / admin only)
   pick a starter map, or drag areas to build one  ---> SAVE (checked, versioned)
      |
      v
 teammates sign in, open the room
   arrive in the arrival area -> walk -> sit (within 120 px of a seat)
   engine as tested: movement, proximity, batching, seats
```

## What exists today (found by reading the code)

- One transaction creates the workspace, the owner's membership and one room "Main Office", with `config: { layoutId: "openOffice@1" }` (`apps/web/src/app/api/workspaces/route.ts:55-70`).
- The room's layout is chosen by name from a list written in code. An unknown name silently becomes the default office, on purpose: "a bad Room.config must never brick a room" (`packages/shared/src/layouts/queries.ts:53-66`).
- The realtime server reads the layout once when the first person joins and keeps it for as long as the room has people: "ensureRoom no-ops while a record for this room still exists" (`apps/realtime/src/socketHandlers.ts:168-172`).
- The server and the browser each work out the layout separately from the same room settings (`socketHandlers.ts:141-142` and `apps/web/src/app/room/[roomId]/page.tsx:49-50`), and the canvas and the zone chip look it up again by name.
- People arrive in a ring around the middle of the layout's arrival area (`socketHandlers.ts:183,201`).
- Someone can sit only within 120 px of the seat (`packages/proximity/src/seatOccupancy.ts:25`). Seats are remembered only in the server's memory.
- Roles are owner, admin and member (`packages/db/prisma/schema.prisma:86-90`). `Room.config` is a free-form JSON column, meant for this kind of setting (`schema.prisma:151`).
- A layout is checked for mistakes only when the code is built, because "a layout is static, product-authored data, not user input" (`packages/shared/src/layouts/validate.ts:22-27`). A company's map **is** user input, so this must change.
- The current room screen draws furniture from the layout. The map conversion (`spatialMap@1`) produces no furniture, because the Gemini screen draws its own. So a room on the new map would look empty on the current flat canvas.

## Decisions

**D1. Where a company's map lives.** In the room's existing settings column as `config.map`: a list of areas and a version number. No database change is needed for the live map. (The version history in D4 adds one table.) The workspace and its first room are still created together, as today, from a starter map. The admin panel edits the map; there is no separate "create room, then workspace" order.

**D2. Coordinates: three worlds, one rule each.**
| World | Unit | Who uses it |
|---|---|---|
| Builder | tiles on a 160 px grid (an area is column, row, columns wide, rows tall) | what the admin drags and what is saved |
| Engine | pixels: tile x 160, one to one with the map's own units (measured scale check: no rescaling) | server, seats, proximity, walking limits |
| Screen | the flat pixels turned by one tilt (rotate X 55, Z -45, then scale) | drawing, and clicks turned back into flat pixels |
The builder snaps to the grid because the engine already stores zones as tile rectangles. Areas are rectangles in version 1 (no polygons). The tilt and its inverse live in one shared function, with tests, so a click and a server position always agree.

**D3. Seats and where people stand.**
- Seats are made from the area type: a desk pod has four seats, a meeting room its chairs, focus pods one seat per desk, the lounge its stools.
- Version 1 is **hot-desk**: any free seat, first come. Nobody owns a desk.
- Everyone arrives in the **arrival area** (the plaza). A map has at most one; with none, the first area is used.
- To sit, a person walks to the seat and clicks it (engine rule: within 120 px). They then stand up by walking away.
- Not in version 1: an assigned desk, "jump to my desk", remembering your seat between visits. Add them when a pilot team asks; the seat ids must then stay stable, which is why pods get ids from their grid position, not from their order.

**D4. Who may change the layout: strict, on the server, every time.** The owner and admins only. Nobody else, unless an admin gives them a role that allows it. Hiding a button is never the protection: every save, delete, restore and role change is checked on the server against the person's real role, and a refusal says why.
- **Roles:** `owner`, `admin`, a new role `designer` (may change the layout and nothing else: cannot invite, remove or promote anyone, and cannot change the plan), and `member` (sees the map, can walk and sit, cannot change it).
- **Who can give a role:** only an owner or admin. A designer cannot give anyone a role, including themselves. The last owner cannot be removed or demoted.
- **Every change is recorded:** who, when, and which version. Nothing is edited in place; each save is a new version.
- **This needs two small database additions** (a new role value, and a table of layout versions). They add data; they do not change how the engine works.

**D10. Draft, preview, publish, and going back.**
- An editor works on a **draft** that only editors see. Members keep seeing the live map until the editor presses **Publish**.
- **Preview** shows the draft exactly as members will see it (drawn by the same code), at the size of a laptop, a large monitor or a phone, with sample people standing in it, clearly labelled "Preview".
- The editor can **add** an area, **move** it, **resize** it, **rename** it, **change its type**, **duplicate** it and **delete** it, with undo and redo, and can **reset to a template**.
- **Old versions are kept.** The editor can go back to any earlier one. Deleting an area never destroys the history.
- Publishing still follows D5: the new map is used the next time the room is empty.
- Two editors at once: the second Publish is refused with the current version, so nobody overwrites anyone by accident.

**D11. The map must fit the screen.**
- The screen opens with the **whole map fitted** to the window, on a laptop, a monitor or a phone, and zooms to fit again when the window changes.
- If fitting the whole map would make people too small to read (a minimum size, proposed and to be tested), the screen opens on the arrival area and offers zoom and drag.
- The builder shows a **screen frame** on the map and a warning when the map's shape is far wider or taller than a normal screen, and suggests a shape that fits better.
- The limit on the floor (D6) stays. The builder shows the seat count next to the number of people the plan allows online.

**D12. Setting up from needs, for any size, and recommended from 50 people.** The first step asks what the team needs (how many people, how many meeting rooms, focus pods, a lounge). The system **arranges a first layout automatically** on the grid, in a shape that fits a screen, and shows the preview. The admin then edits it (D10) or picks a template instead. The arrangement is a plain, repeatable rule (rows of desk areas, meeting rooms along one side, lounge and plaza in the middle), not guesswork, and it is tested to stay inside the limits. The admin decides; nothing goes live until they publish.

**D5. When an edit goes live.** Each save makes a new version. A room that already has people keeps its current map until it next empties, because the server holds the layout for as long as anyone is inside. The admin panel says so. "Apply now" (asking everyone to reconnect) is a later addition. This needs no change to the engine.

**D6. The map is untrusted input, so it is checked twice: when saved and when loaded.** Proposed limits, unmeasured above what we have tested (100 people, 105 seats): floor at most 50 x 50 tiles (8,000 px, the engine's own limit), at most 60 areas, at most 400 seats, names at most 60 characters, ids of letters, digits, dash and underscore only, meeting rooms and cabins must not overlap, at most one arrival area, and every area inside the floor. The map may hold more seats than the plan allows people online; the panel shows both numbers. The plan's limit on people online is unchanged and independent of the map.

**D7. A stored map that is broken must never silently change the office.** On load, a map that fails the checks falls back to the room's named layout (or the default office), and the reason is returned so it can be logged and the admin panel can say why. The existing "never brick a room" rule stays.

**D8. One place decides the layout.** A single function, `resolveRoomLayout(config)`, in the shared package, used by the server, the room page, the canvas and the zone chip. Today each does its own lookup by name; a custom map cannot be looked up by name, so those callers must take the layout itself.

**D9. Order of work protects existing users.** New workspaces keep the old office until the new map screen exists, because the current flat canvas would draw a new-map room with no furniture. Nothing changes for anyone today.

## Build order (each step small, tested first, and stops for review)

| Step | What | Changes behaviour for existing rooms? |
|---|---|---|
| A | The map format, its checks, and `resolveRoomLayout` in the shared package (no screens). **Done, 2026-09-21** (`packages/shared/src/layouts/roomMap.ts`, 18 tests) | No |
| B | Server, room page, canvas and chip use `resolveRoomLayout`. **Done, 2026-09-21** (commits `14967b0`, `d0a07a1`) | No (same result for every room that exists, checked against the old lookup) |
| C | The strict rules: the `designer` role, the versions table, and the server checks for save, publish, restore and role changes, with a record of who changed what, and a who-may-do-what test table. **Done, 2026-09-21** (C1 rules `f2f7105`, C2 database `49c790e` and `628cc52`, C3 routes below). No screens use it yet | No (nothing calls it yet) |
| D | The map screen with real people and click-to-move. **Start with a measurement** of 100 moving people in a browser, on this design | Only for rooms on the new map |
| E | The builder in the admin panel: the setup from needs (D12), drag, resize, rename, delete, undo, the preview at screen sizes, fit to screen (D11), publish and go back (D10) | Only for editors |
| F | New workspaces start from the starter map | Yes, deliberately, after D and E |

## Failure modes (one realistic failure each)

| Where | Failure | Handled by |
|---|---|---|
| Save | Two admins save at once; the second overwrites the first | Version number; a stale save is refused with the current map (step C) |
| Save | A map with a huge floor or thousands of seats to slow the server | Limits in D6, refused on save and on load |
| Load | Stored map fails the checks after a code change | D7: fall back, log, tell the admin. Never blank |
| Join | Server and browser compute different layouts from the same settings | One shared function (D8), with a test that both agree |
| Live room | Admin edits while people are inside | D5: the old map holds until empty; the panel says so |
| Sit | A seat sits outside its own area, so audio and counts miss the person | A test that every seat is inside its area (exists for the starter map) |
| Click | Clicks land in the wrong place on the tilted map | The inverse tilt and its round-trip test (step D) |
| Permissions | A member calls the save address directly, skipping the screen | The server checks the role on every call; a test for each role and each action (D4) |
| Permissions | A designer promotes themselves, or the last owner is removed | Refused on the server; tests for both |
| Permissions | A person who lost the role keeps an old tab open and saves | The role is checked at save time, not at page load |
| Fit | A very wide map is unreadable on a phone | D11: opens on the arrival area with zoom and drag, plus a warning in the builder |
| Setup | The automatic arrangement breaks a limit or overlaps meeting rooms | The arrangement is tested against every rule in D6 before it is shown |
| History | An area is deleted by mistake | Every version is kept; restore any earlier one (D10) |

## Not in scope (considered and deferred)

Assigned desks; jump to a person, area or seat; polygons and art templates; several rooms in one workspace; billing and plan changes; applying an edit to a live room; splitting areas across servers; 200 and 500 people with seats; anything on the engine or the proximity algorithm.

## Test plan

- **Shared (step A):** valid starter map accepted and equal to `spatialMap@1`; every rule in D6 refused with a clear message; unknown fields dropped; `resolveRoomLayout` gives the default for empty settings, the named layout for a known name, the custom map for a valid `map`, and the default plus a problem message for a broken one.
- **Wiring (B):** existing rooms resolve exactly as before; a room whose settings hold a custom map joins on it (real database); server and browser agree.
- **Strict rules (C), a table with one test per cell:** for each of not signed in, member, designer, admin and owner, and for each of read the live map, save a draft, publish, restore an old version, and change someone's role: allowed or refused, exactly as D4 says. Plus: the last owner cannot be removed, a designer cannot promote anyone, a stale version is refused, an invalid map is refused with reasons, and every change is recorded with who and when.
- **Builder (E):** the preview is drawn by the same code as the live map; the automatic arrangement stays inside every limit for headcounts from 5 to 200; the map fits a laptop, a monitor and a phone; undo, redo, delete and restore work.
- **Map screen (D):** the click and world round-trip; a person sits when walking to a seat and clicking; the 100-person browser measurement is taken once and reported before anything else is built on it.

## Server routes added in step C (no screen uses them yet)

| Address | Who may | What it does |
|---|---|---|
| `GET /api/rooms/[roomId]/layout/versions` | owner, admin, designer | history, newest first, and which version is live |
| `GET /api/rooms/[roomId]/layout/versions/[version]` | owner, admin, designer | one saved version with its map |
| `POST /api/rooms/[roomId]/layout/versions` | owner, admin, designer | save a map as a new version (`{ map, baseVersion }`); 409 if it is not based on the newest |
| `POST /api/rooms/[roomId]/layout/publish` | owner, admin, designer | make a version live (`{ version, expectedLiveVersion }`); 409 if someone published first |
| `POST /api/rooms/[roomId]/layout/restore` | owner, admin, designer | save an old map again as the newest version (`{ version }`) |
| `PATCH /api/workspaces/[workspaceId]/members/[userId]` | owner, admin (limits in D4) | give a role (`{ role }`) |

The person asking is always the signed-in person; the rules run in the database functions on every call. A person outside the workspace is told "not found", never "forbidden".

## Deployment note

The new role value and table are additive, so deployment (which backs up first) is safe. One caution: once anyone has been given the `designer` role, rolling back to an older version of the app would fail to read that person's membership. Roll back before giving out the role, or roll forward.

## Step D, part 1: the browser measurement (measured 2026-09-21, 200 people)

The launch target is **up to 200 people in one space** (the Enterprise plan's cap). One measurement page moves 200 people around the real starter map in three ways. Each way was run once, for 15 seconds, with the processor slowed to a quarter of its speed to imitate a weak laptop. Page: `docs/spikes/map-perf/index.html` (a throwaway test, not part of the product).

| | Plain HTML, the browser animates | Plain HTML, the page moves everyone each frame | Canvas (Pixi, what the room screen uses) |
|---|---|---|---|
| Frames per second | 38.6 | 39.0 | **58.3** |
| Frame time, 95th percentile | 50.3 ms | 50.1 ms | **17.4 ms** |
| Frame time, 99th percentile | 149.8 ms | 116.8 ms | **32.3 ms** |
| Slowest frame | 633 ms | 466 ms | **216 ms** |
| Frames slower than 50 ms | 36 of 579 | 30 of 585 | **3 of 875** |
| Share of the main thread busy | 75% | 84% | **12%** |
| Page elements | 336 | 336 | 15 |
| Set-up time | 8 ms | 14 ms | 426 ms |

**How to read it.** In this test the canvas was much lighter than plain HTML for 200 moving people. The HTML versions kept the browser busy three quarters of the time and dropped many frames. A likely reason, not verified: every moving element makes the browser repaint part of one large tilted layer, while a canvas draws all the people in a single pass. One thing not tried: giving each person a layer of their own, which may help HTML but costs memory for 200 layers.

**What this does not show.** It was run in a browser with no graphics chip (software drawing) on a small PC, so it says nothing about battery, and a real laptop or phone may differ. To repeat it on your own device: run `node docs/spikes/map-perf/serve.mjs`, open `http://127.0.0.1:8123/docs/spikes/map-perf/index.html?mode=css&auto=1` (then `mode=raf` and `mode=pixi`), wait 20 seconds, and read the numbers on the page. Stop the server with Ctrl+C.

**D13. Decision from this evidence: the live map is drawn on the canvas, as today.**
- The world is drawn from the same map data, in the Gemini look and tilt, and the fixed parts (floor, areas, furniture) are drawn once into a cached picture, not redrawn.
- People are simple sprites, with no blur or glow.
- The canvas stops drawing when nothing moves. Today the room screen's loop runs every frame even when idle; making it stop itself is part of the light-weight work and is not done yet.
- Plain HTML and CSS stay for the home-page demo, the panels, the builder's controls and the preview frame, where there are few moving parts.
- This overrules my earlier plan to draw the whole map as plain HTML. If a real device shows a different result, this decision can be revisited.

## Step D, part 2: the room screen rests when nothing moves (built and measured 2026-09-21)

**What changed.** The room's drawing loop used to ask the browser for a new frame on every screen refresh, all the time. It now rests after five quiet frames and wakes the instant anything happens: a key, a click, a drag, the wheel, a resized window, the tab coming back, or anyone moving, joining, leaving or sitting. Pixi's own two spare clocks (one for pointer events this screen does not use, one for its memory clean-up chores) rest and wake with it. Files: `apps/web/src/canvas/idleGate.ts`, `PixiStage.ts`, `apps/web/src/input/MovementController.ts` (a new `needsFrames()` so the last step of a walk is never left unsent).

**Measured in a real browser** (the room page, signed in, connected to the realtime server; Microsoft Edge without a graphics chip on the owner's small PC, so this shows processor work, not battery):

| | before | after |
|---|---|---|
| Frames requested per second, nobody doing anything | about 179 | **0** |
| Share of the browser's main thread busy, idle | 13% | **about 0.1%** |
| While a key is held or a walk is under way | drawing every frame | drawing every frame (about 60 a second per clock) |
| After the person stops | kept drawing | **back to 0** within a fraction of a second |

The person visibly moves with the keyboard and with a click, and a drag on the canvas redraws, so nothing was lost.

**A mistake caught by checking, worth remembering.** While removing a temporary test line I accidentally joined the next line, the one that connects the room to the realtime server, onto the end of a comment, so the room stopped connecting (badge stuck on "Idle"). The unit tests could not see it because the canvas needs a real browser. Comparing against the original code found it. Any change to this file needs a real-browser check that the badge says "Connected".

**Still to do for D13:** draw the company's own map on the canvas from its data with the fixed parts cached, and repeat the browser measurement with 200 moving people on that map.

## D14. The floating bar under the map (the owner's words, 2026-09-21)

The owner asked for a **sleek bar floating below the screen** that never spoils the map: the map keeps everything it has, and the bar sits beneath or over an empty edge, never over the picture of the office.

| In the bar | Who sees it | Built today? |
|---|---|---|
| Zoom in, zoom out, fit the whole map | everyone | Zoom by wheel exists; the buttons and "fit" do not |
| Find a person, or go to my desk | everyone | No. Needs a "go to" action the server does not have (only sitting teleports) |
| A search box to find and reach people | everyone | No. Needs the list of people (exists in the browser) plus the same "go to" action |
| Edit map | owner, admin, designer only | No (the rules and routes exist; no screen yet) |
| Microphone, camera, leave | everyone | Audio switch exists; camera and a clear Leave button to be checked |
| Live status with counts: green = live, red = away, blue = focus, yellow = idle | everyone | **No. There is no status today.** Needs a status for each person, sent through the realtime server |

**Proposed meaning of the statuses (to be confirmed with the owner before building them):** *Live* = in the room and active. *Away* = the person chose Away, or the tab has been hidden for a while. *Focus* = the person chose Focus (do not disturb: others should not walk up to them). *Idle* = no keyboard or mouse for a few minutes. The bar shows how many people are in each. Adding a status to what the realtime server sends about each person is a small change to the message format, so it needs the owner's approval when we reach it.

**Order of work:** (1) the company's map looks like a real office (furniture drawn from the map's areas), (2) the bar with the buttons that need no server change (zoom, fit, leave, microphone, Edit map), (3) find and go-to, (4) status and counts.

## D15. The room screen, tilted, raised and with its bar (built and checked in a real browser, 2026-09-21)

**What changed on screen.** The owner asked for one design everywhere (the Gemini look): dark charcoal, one amber accent, a tilted floor, people as dots. The room screen now does this. It is drawing only: the server, the engine, the layout data and the seats are unchanged.

| Piece | How it works | Where |
|---|---|---|
| The tilt | The flat floor is turned 45 degrees and leaned back 55 degrees (the Gemini map's own numbers). Every click, walk, zoom and "fit" goes through a few tested functions, so a click on the tilted picture and a position on the server agree. | `canvas/isoMath.ts` |
| People and seat markers | Drawn upright inside the tilted floor, so dots stay round and names stay level. | `Avatar.ts`, `SeatOverlay.ts` |
| Raised plates | Each area with 3 or more desks or tables is drawn as one small plate per desk group with floor between the plates; an area with fewer stays one plate. Any template goes through the same rule. Every seat is on a plate (tested). | `canvas/slabPlan.ts`, `FloorView.ts` |
| Elevation on hover | The plate under the mouse rises (thickness, higher position, growing shadow). No colour change. The furniture, seat markers and people on it rise with it. | `canvas/lift.ts`, `PixiStage.ts` |
| The bar under the map | One row of icon buttons: microphone, camera, share screen, find people, emoji, status, invite to talk, leave. | `components/RoomDock.tsx` |
| Zoom buttons | Zoom in, zoom out and fit, bottom-right (above the bar on a phone). | `components/ZoomControls.tsx` |

**Battery, measured in a real browser.** With nobody moving and the mouse anywhere: 0 frames drawn in 2 seconds. Moving the mouse inside one raised plate: 2 frames in 2 seconds. Crossing onto another plate: about 30 frames over about 0.44 seconds, then the drawing stops by itself again. Nothing keeps a timer running.

**What works and what is shown but switched off in the bar.**

| Button | State |
|---|---|
| Microphone | Works. Amber until the person turns audio on with a click (a browser rule), then mute and unmute. |
| Find people | Works. Lists everyone in the room, narrows as the person types, and a click walks to that person. This needed no server change: it uses the same walk-to-a-point as clicking the floor, so the server's movement checks still apply. (This replaces the earlier note that a server "go to" action was needed.) |
| Leave | Works. Goes back to the home page. |
| Camera, share screen | Switched off ("coming soon"). The app has no camera or screen-share support yet. |
| Emoji, set status, invite to talk | Switched off ("coming soon"). They need new messages through the realtime server, which needs the owner's approval first. |
| Edit map | Not on the bar yet. Only owners, admins and designers may see it, so it waits for the room page to pass down the person's role. |

**Known limits, to decide later.**
- Notes, shapes and images lie flat on the tilted floor (readable, but not standing up).
- The floor is fitted to the window when the room opens and when "fit" is pressed; it does not refit by itself if the window is resized afterwards.
- The status colours (green, red, blue, yellow) and their counts are still to be built, once the owner confirms the meanings proposed under D14.

**A mistake the browser check caught (again).** The first version of the "fit" button also woke the drawing loop, and it was called during start-up before that loop existed, so the room opened blank. A test run would not have shown it. Any change to `PixiStage.ts` still needs a real-browser look: the badge must say "Connected", the person must move when clicked, and the map must show.

## D16. CEO review of steps E and F (2026-09-21, selective expansion; the owner decided every item)

Written for: the product owner first, then whoever builds it.

**Approach (the owner's words).** "Full drag builder, for a subscription of more than 10 people; the others get a prefixed template." In the plans this is: **Startup (10 people) gets ready-made templates only; Team (25), Company (50), Large (100) and Enterprise (200) get the drag builder.** The rule reads the same plan lookup as the participant limit ("more than 10"), so a later billing change moves both together. It is checked on the server on every save and publish, like the role rules, never only by hiding a button.

**Seats do not set capacity (the owner).** Only the plan decides how many people may be online. A map may have more or fewer seats than that. So Startup needs no special small templates, and "fewer seats than people" is information in the map check, not an error.

| # | Decision | Chosen |
|---|---|---|
| E1 | Startup admins may try the builder in their own browser; Publish is locked with an upgrade message. The draft stays in the browser, so the server rule is untouched | Added |
| E2 | Teammates walk a private draft before it goes live | Not in scope |
| E3 | "Apply now" for a live office | Added, and merged into 4A below |
| E4 | Assigned desks and "go to my desk" | Not in scope. Any-free-seat stays; this also drops "go to my desk" from D14. Find-a-person stays |
| E5 | Save my office as my own template | Deferred (TODOS.md) |
| E6 | A "does my office work?" check in the builder (seats vs people as information, screen fit, far-apart meeting rooms) | Added |
| 1A | A workspace whose plan drops to Startup keeps its map; editing is locked with a message; the admin may switch to a template; every earlier version stays | Chosen |
| 1B | How Apply now works: reset the room with the server's existing failover path, and tell each browser to reload after a random 0 to 5 second wait (so 200 people do not arrive in one second). The map is saved either way | Chosen |
| 3A | A small record table: who gave or removed which role, who published, restored or applied a map, and when. Written in the same step as the change. Owners and admins can read it | Chosen. One additive table; older code ignores it |
| 11A | The builder edits on a flat top-down grid; a Preview button shows the tilted, raised-tile view, drawn by the same code as the live room | Chosen |
| 11B | Editing on a tablet-sized window and up; on a phone the builder is view, preview, version history and restore only | Chosen |
| 4A | **Publish into an occupied room resets it** (see the gap below) | Chosen |

**A gap in D5, found in this review.** Publishing writes the new map into the room's settings immediately, and the room page reads those settings when it opens. But the realtime server keeps the old map for as long as anyone is inside. So after a publish into an occupied room, a newcomer would draw the new map while the server used the old one (seats refuse, walking limits wrong). A stale tab reconnecting after a reset has the same problem. **Decision 4A replaces D5 for occupied rooms:** publishing into a room with people in it first shows how many are inside and asks for confirmation; on confirm the map is saved and the room is reset so the server and every page agree within seconds. If the reset fails, the publish is undone and the admin is told why. When a browser reconnects it also checks the live map version and reloads if its page is out of date. An empty room simply takes the new map the next time anyone joins, as before. The longer-term cleaner fix, the server sending its own map to each browser, is deferred because it changes a server message and the room screen's start-up code.

### How the pieces fit (★ = new)

```
 admin (Team+)            web app                          database                     realtime server
 builder ★ ── save ──▶ layout routes (exist) ──checks──▶ role rule (exists)
 (flat grid;             + plan rule ★ (limit > 10)         + plan lookup (exists)
  Preview = tilted,      ── write ──▶ RoomLayoutVersion (exists) + audit record ★
  same drawing code)             │
 Startup admin ★ ── template pick ─▶ same routes: anything but a template is refused
                                 │
 Publish into a live room ★ ─▶ confirm (N inside) ─▶ save map ─▶ internal call ★ ──▶ evict room (exists, used for failover)
                                                                                        │ every socket told to reconnect
 every browser ◀── "map changed" ★ ── reload page after 0-5 s ◀────────────────────────┘
      └─▶ on reconnect: compare the live map version with the page's; reload if different ★
```

### Error and rescue registry

| Where | What can go wrong | Caught by | The person sees |
|---|---|---|---|
| Save or publish by a plan of 10 or fewer | A Startup member calls the route directly | Server checks the plan every call | "Your plan does not include the builder", refused; logged |
| Plan drops | A Team workspace goes down to Startup | 1A: map kept, editing locked | A clear message; templates still available |
| Publish into an occupied room | The room's server cannot be reached, or the reset fails part-way | The publish is undone; the earlier version stays live | "Could not apply now; nothing changed" |
| Publish into an empty room | Nobody inside | No reset needed | Publishes as before |
| Browser reload | 200 browsers reload at once | Random 0 to 5 second wait | A short "the office is updating" screen |
| Stale tab | A tab open across a publish reconnects with the old map | Map version check on reconnect | The page reloads |
| Two admins | Both press Publish | Version number (exists) | The second is refused with the current version |
| Audit | The record cannot be written | Written in the same step as the change, so both succeed or both fail | The change is refused, not silently unrecorded |

### Failure modes registry

Every row above is rescued, tested (listed below) and visible to the person or in a log. No critical gap is left open. The one that was open, the map mismatch, is closed by 4A.

### What already exists and is reused

The map format and checks, the role rules, the saved-versions table and routes, the room's failover reset, the plate drawing code (the builder's preview), and the plan lookup used for the participant limit. Nothing is rebuilt.

### Not in scope

Teammates walking a private draft (E2); assigned desks and "go to my desk" (E4); furniture that blocks walking (an engine change); the server sending its own map to each browser (later, needs a server message change); the "save as my own template" idea (E5, in TODOS.md).

### Tests added by this review

- The who-may-do-what table gets a plan column: role x plan x action, one test per cell.
- A Startup member cannot save a draft or publish; a Startup admin can pick a template.
- A downgrade keeps the map, locks editing, and keeps every version.
- Publishing into an occupied room resets it, and the rejoined room uses the new map (real database and server); a failed reset undoes the publish.
- A stale page reloads on reconnect.
- One audit line is written per action, with the right person, and none when the action is refused.
- At a phone width no edit handles appear in the builder.

### Build tasks (each stops for review)

1. **P1** The plan rule and its test table; the audit table and its writes. Human about 3 days, Claude about 2 hours.
2. **P1** Publish into an occupied room: confirm box, reset through the existing failover path, undo on failure, reload after 0 to 5 seconds, and the version check on reconnect. Human about 5 days, Claude about 4 hours.
3. **P1** The template picker for every plan (Startup limited to it). Human about 3 days, Claude about 2 hours.
4. **P1** The set-up-from-needs arrangement (D12) with the map check (E6). Human about 1 week, Claude about half a day.
5. **P2** The flat drag builder with Preview, undo, redo, version history (D10, 11A, 11B). Human about 2 weeks, Claude about 1 day.
6. **P2** The Startup try-out with a browser-only draft (E1). Human about 2 days, Claude about 1 hour.
7. **P2** New workspaces start from the starter map (step F).

Outside voice: not run in this review (no second reviewer was available here). That is missing coverage, not a clean result.

## D17. Design review of the map builder (2026-09-21; the owner decided every item)

Written for: the product owner first, then whoever designs and builds the builder screens.
Sketches (drawn by hand as web pages; the picture tool needed an OpenAI key, which was not set up): [main screen](../designs/map-builder/wire-builder.png), [teal accent candidates](../designs/map-builder/accent-candidates.png), [no-colour options](../designs/map-builder/neutral-options.png).

Design completeness went from 3 out of 10 to 8 out of 10. Nothing was built in this review; these are requirements for step E.

| Pass | Before | After | Note |
|---|---|---|---|
| 1 Information architecture | 3 | 9 | Layout below |
| 2 States (loading, empty, error, success, partial) | 2 | 9 | Table below |
| 3 Journey and feelings | 3 | 8 | Storyboard below; wording decided in Pass 7 |
| 4 Generic-looking design | 6 | 7 | The owner chose "only match DESIGN.md": no extra look rules |
| 5 Design system alignment | 4 | 9 | Colour, control size and map text decided |
| 6 Responsive and accessibility | 2 | 9 | Mouse and keyboard together; tablet drawers |
| 7 Open decisions | n/a | all resolved | Below |

### The screen (decision 1A)

```
 top bar:  office name | "Draft saved 12:04" | Undo | Redo | Edit / Preview | Publish
 +-------------+-------------------------------------------+---------------------+
 | Add an area |                                           | The selected area   |
 |  Desk area  |        THE MAP  (flat, top-down grid,     |  Name               |
 |  Meeting    |         a dashed "laptop screen" frame)   |  Type               |
 |  Focus pods |                                           |  Size (tiles)       |
 |  Lounge     |                                           |  Seats              |
 |  Plaza      |                                           |  Duplicate / Delete |
 | History     |                                           |                     |
 +-------------+-------------------------------------------+---------------------+
 bottom strip: "Does my office work?"  (plain sentences; "All good" when fine)

 Team and above:  Set up from needs -> Builder (edit) <-> Preview (tilted) -> Publish -> History
 Startup:         Pick a template ---------------------------------------> Publish -> History
                  (Startup sees the builder only as a try-out; Publish is locked)
```

First, second, third: the map; the selected area's details and Publish; adding areas, history and the notes strip. The builder edits on the flat grid (decision 11A); Preview shows the tilted, raised-tile view drawn by the same code as the live room.

### States (decision 2A)

| Feature | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| Opening the builder | Grid outline and "Opening your office..." (panels already shown) | A Team workspace with no map: never a blank grid; two buttons, "Set up from your team's needs" and "Choose a template" | "We couldn't open your office. Try again." with a Retry button; the live office is unaffected | The map and "Draft saved" | A saved map that now fails its checks: "This version has a problem: (reason). The live office is not affected." and "Go back to the last good version" |
| Saving the draft | "Saving..." beside the name | n/a | "Not saved. Your changes are kept on this computer and we'll retry." | "Draft saved 12:04" | Offline: "Saved on this computer only" |
| Dragging or resizing | n/a | n/a | A broken rule (overlap, outside the floor, too many areas) snaps the area back and says why in one plain sentence under the map, announced to screen readers | Area placed | n/a |
| Publish | Button says "Publishing...", disabled | n/a | "Someone published version 8 first. Review their version." Any other failure names the reason and says nothing changed | "Published. 12 people are reloading." | The occupied-room box; "the reset failed, nothing changed" |
| Version history | Grey list rows | "Only version 1 so far" | "Couldn't load history. Try again." | Restore asks "Go back to version 5?" | n/a |
| "Does my office work?" strip | "Checking..." | "All good. Nothing to note." | "Couldn't run the checks" | The notes list | n/a |

### The journey (Pass 3)

| Step | The admin does | Feels | What the plan provides |
|---|---|---|---|
| 1 | Signs up, creates the workspace | Curious, a little worried it will be hard | The office already exists from a starter map (D9) |
| 2 | Opens the builder the first time | Wants control, easily overwhelmed by a blank page | Never a blank grid: set up from needs, or a template |
| 3 | Sees the first arranged office | Relief and delight | Tilted Preview with sample people |
| 4 | Drags things around | In control, afraid of ruining it | Undo, redo, "Draft saved", history |
| 5 | Reads "Does my office work?" | Reassured | Plain sentences; "All good" when all is fine |
| 6 | Presses Publish with people inside | Nervous | The "N people" box; "nothing changed" if it fails |
| 7 | Sees it go live | Pride and relief | "Published. 12 people are reloading." |
| 8 | (Startup) meets the locked Publish | Mild disappointment; at risk of feeling nagged | One calm message, never repeated |

### Decisions

- **Look (4A).** No invented look rules. The builder and the live room follow `DESIGN.md` exactly: its tokens, controls at least 48 px tall (so 48 px in the builder too), text at least 16 px, the themed focus ring.
- **Accent colour (owner).** Amber is removed as the accent everywhere. The one accent becomes **soft teal `#2dd4bf`** (readability 10.4 to 1 on the ground `#0b0d12`; dark text on it 10.4 to 1). It goes on the main button, the selected item, the highlighted headline words and the person's own dot in the room. `DESIGN.md`'s `accent` and `link` tokens, the colour test in `designTokens.test.ts`, the room screen (currently amber `#f5a623`), the landing page and sign-in must be changed when this is applied; that is a work item, not done in this review. The neutral options (white or black main button) were considered and not chosen.
- **The live room follows `DESIGN.md` strictly (owner).** Today the room uses the Gemini mock-up's own values (ground `#0a0a0a`, 40 px bar buttons, 13 to 15 px name tags). Those must move onto the `DESIGN.md` tokens and sizes. The builder's Preview inherits this because it is drawn by the same code.
- **Text drawn on the map (5B).** Area names always draw at 16 px on screen. A person's name tag draws at 16 px only for the local person, people nearby, the person under the mouse and anyone found through search; everyone else is a plain dot until the map is zoomed in. This keeps 200 people readable and meets the 16 px rule. It needs a small change to how the room draws names.
- **Keyboard and screen readers (6A), together with mouse and touch.** Tab picks an area; arrow keys move it one tile; Shift plus arrows resizes it; Delete removes it (Undo restores it, so there is no extra confirm); Escape cancels a drag and puts the area back. Every move and every refusal is announced, for example "Product moved to column 5, row 3". Focus is always visible with the `DESIGN.md` ring. A test moves an area using only the keyboard.
- **Publish into an occupied room (7A).** Title "Publish now?". Body "12 people will reload." Buttons "Publish" and "Not yet". An empty office shows no box and publishes at once. The box has no amber (there is none anywhere now).
- **Startup message (7B).** Publish stays visible. Pressing it opens one box: "Publishing your own layout is part of the Team plan. Your draft stays here on this computer." Buttons "See plans" and "Choose a ready-made template". A quiet "Try-out: not published" stays in the top bar. Nothing else nags.
- **Tablet (7C).** Below 1100 px wide the map takes the full width and the two side panels become drawers opened by 48 px buttons at the map's edges. Details open when an area is selected and close with Escape or a tap outside. Phones are view-only (D16, 11B).
- **Told apart by name, not colour.** Area types are told apart by name and a small type icon, because there is one accent. Deleting has no extra confirmation because Undo restores it.

### Battery (the owner asked)

By design the builder draws nothing while idle (the same "rest when still" rule as the live room, which measured 0 frames idle), draws only while something moves, saves the draft once shortly after editing stops (no background timer) and uses no blur or glow. This is a design, not a measurement: once built, measure idle and drag cost in a real browser as was done for the room.

### Work items this review adds

1. Apply the teal accent to `DESIGN.md`, `globals.css`, `designTokens.test.ts`, the landing page, sign-in and the room.
2. Move the live room onto the `DESIGN.md` tokens, control sizes (the bar and zoom buttons are 40 px today) and text sizes, including the name-tag rule above.
3. Builder screens as specified above, with the states table, keyboard test, tablet drawers and phone view-only behaviour.
4. Measure the builder's battery cost once built.

Outside voices: not run in this review (no second reviewer was available). That is missing coverage, not a clean result.

## D18. Workspace colour option and the first-time set-up flow (2026-09-22, the owner's request)

This adds to the plan; nothing decided in D1 to D17 is changed. Note: after D17 the owner asked to go back to the earlier look of the room (text sizes, panel colours, bar size and the amber accent), so those code changes were reverted (commits f1fa12f, f7173ec, 39360f3). The words in D17 about 16 px text, 48 px bar buttons and the teal accent describe what was decided then, not what the room shows today. Whatever the room shows today is the **default** below.

### 1. Workspace colour (an option, not a redesign)

An owner or admin can choose one accent colour for their workspace from six ready-made palettes. **The system default stays exactly as it is today; nothing changes until an admin picks one.** Only colours change. **No text size and no button size changes.**

| Palette | Accent | Hover | Glow | Monitor / chair glow | Vibe |
|---|---|---|---|---|---|
| Sunset Coral & Rose | `#f43f5e` | `#e11d48` | rgba(244, 63, 94, 0.35) | `#fda4af` / `#f43f5e` | Warm, high-energy |
| Electric Cyan | `#0ea5e9` | `#0284c7` | rgba(14, 165, 233, 0.35) | `#7dd3fc` / `#0ea5e9` | Technical, clean |
| Emerald & Teal | `#10b981` | `#059669` | rgba(16, 185, 129, 0.35) | `#6ee7b7` / `#10b981` | Calm, growth |
| Electric Indigo | `#6366f1` | `#4f46e5` | rgba(99, 102, 241, 0.35) | `#c7d2fe` / `#6366f1` | Deep focus, premium |
| Twilight Amethyst | `#8b5cf6` | `#7c3aed` | rgba(139, 92, 246, 0.35) | `#c4b5fd` / `#8b5cf6` | Creative, calm |
| Cyber Lime | `#22c55e` | `#16a34a` | rgba(34, 197, 94, 0.35) | `#86efac` / `#22c55e` | High-tech, energetic |

- **Where it applies:** the accent (main buttons, selected item, links), its hover colour, the glow, and the glow on a person's monitor or chair in the room. Everything else (ground, panels, text, sizes) is untouched.
- **Who may set it:** owner and admin, checked on the server every time, like every other admin change (D4). It applies to everyone in that workspace, in the room and in the admin screen.
- **Stored** as a palette name on the workspace (one small database addition, later), not as free text, so only the six known palettes can ever be saved.
- **Readability check (measured on the ground `#0a0a0a`):** dark text on the accent must reach 4.5 to 1. Coral 5.4, Cyan 7.1, Emerald 7.8, Lime 8.7, Amethyst 4.7 pass. **Indigo `#6366f1` reaches 4.43, just under 4.5** (white text on it reaches 4.47, also just under). Proposal: keep the palette but use the slightly lighter `#6d70f2` as its accent (to be re-measured), or accept the small miss. The owner decides; a test will check every palette.
- **Preview before saving:** picking a palette shows it on a small sample (a button, a link, a person dot) before "Save colour".

### 2. First-time set-up: what is already decided, and what is new

Already decided and reused: the office exists from a starter map (D9); the first step asks what the team needs and arranges a layout by a plain rule (D12); templates for Startup, full builder above 10 people (D16); the map check (E6); preview tilted, edit flat (11A); publish rules (D17). New in this section: the exact questions, the rule table, the transition and the first-drag hint.

**The questions (five, one per screen, each with a "Not sure" answer that picks the middle option):**

1. **What is the office for?** Company team, School or class, Community or event, Something else. (Decides the names and the mix of areas.)
2. **How many people will use it at the same time?** Up to 10, 25, 50, 100, 200. (Sets the size of the map; this is a suggestion, the plan still decides who may join.)
3. **Which areas do you need?** Tick any: Desk areas (always on), Meeting rooms (how many: 1 to 6), Focus pods, Lounge, Reception or plaza (on by default).
4. **How is your team organised?** One group, or named groups (type up to 6 names, such as Product, Sales). (Each named group gets its own desk area.)
5. **Which colour suits you?** The six palettes (section 1), or "Keep the default". Skipping is fine and it can be changed later.

### 3. How the answers set the starting office (a fixed rule, not guesswork)

| Answer | What appears |
|---|---|
| People (2) | Number of desk seats about the same as the people count, rounded to whole desk groups of 4; the map size follows (fits one screen, D11) |
| Groups (4) | One desk area per named group, named by the admin; with "one group", a single area named "Desks" |
| Meeting rooms (3) | The chosen number of meeting rooms along one side |
| Focus pods (3) | A row of single-seat pods, one per 10 people, at least 2 |
| Lounge / Reception (3) | Lounge in the middle; the arrival plaza is always placed |
| Purpose (1) | Only the area names and starter notes: Company (Desks, Meeting room), School (Classroom, Breakout room), Community (Stage, Chat corner) |
| Colour (5) | The palette from section 1 |

A map that would break a limit is never shown; the map check (E6) runs first and the question that caused it is highlighted with a plain sentence. Startup (10 people) skips this flow and goes to templates (D16).

### 4. The transition from the last question to the canvas

1. Last question, button **"Build my office"**.
2. A short screen with the office outline drawing in area by area (about 2 seconds, skipped at once if the person has asked their device for reduced motion) and the sentence "Arranging your office...".
3. The tilted preview appears with the sample people, and the sentence "Your office is ready. Nothing is live until you publish."
4. One press of "Edit" flattens it into the drag builder. The layout shape never changes between the preview and the editor, so it feels like the same place.
5. It only uses a simple outline and a fade, no blur or glow effects, so it costs almost no battery, and the loop stops when the drawing ends.

### 5. The first drag prompt on the canvas

- One hint, not a tour: a small note pointing at the largest desk area says **"Drag this area to move it."** It disappears as soon as the admin moves anything, and never comes back.
- After the first move, one second hint appears once: **"Drag the corner to resize."**
- A quiet "Take a tour" link stays in the top bar for anyone who wants more.
- The hints can be operated by keyboard too (D17, 6A): the note says "Or press Tab, then the arrow keys."
- Whether the hints were seen is saved per admin so they never repeat.

### Open for the owner

1. Approve the five questions and the rule table, or change any of them.
2. Indigo readability: DECIDED (owner, 2026-09-22): use the lighter `#6d70f2`, measured 4.95 to 1 with dark text (passes 4.5). Its hover shade stays `#4f46e5` until checked in use.
3. Who gets the colour option: DECIDED (owner, 2026-09-22): every plan, including the smallest. Only owner and admin may set it.

### Build items this adds

1. Palette list as one shared file with a test that every palette meets the readability limit.
2. A palette name on the workspace (small database addition) and a server-checked save.
3. The room, the admin screen and the landing page read the palette; the default is unchanged.
4. The five-question flow, the rule that turns answers into a map (with tests that it stays inside the limits), the transition and the two hints.
