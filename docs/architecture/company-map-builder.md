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
