# Template-driven spaces: how any template maps people, desks and chairs to our engine

Status: proposal for review, nothing here is built yet.
Written for: the product owner first, then the product, design, engineering and QA teams. Plain language comes first in every section; technical detail follows it.
Evidence rule used throughout: **measured** means we ran it and have numbers, **proposed** means a design choice, **to test** means a hypothesis we must measure before relying on it.

---

## 0. The whole idea in one page

**Today** one office layout is written in code (`openOffice@1`): a square floor, rectangular zones, seats with positions, furniture that is only drawn.

**Tomorrow** a space (a "Cosmic Canopy" island campus, a plain office, a campus of small buildings, whatever a customer designs) is a **template**: a package of art plus a description of where you can walk, where the seats are, which areas have which rules, and how to draw it in 2.5D.

**The rule that makes this work:** the engine (movement, proximity, audio, seats, travel) never knows what the art looks like. It works on a flat 2D map in fixed units. Every template supplies that flat map, and a projection that turns it into the 2.5D picture. So a new template is new data, not new engine code.

```
   TEMPLATE (data, made by us or by customers)          ENGINE (one codebase, same for all)
  +------------------------------------------+        +----------------------------------+
  |  art layers (the pretty 2.5D pictures)   |        |  who is where (flat 2D positions) |
  |  walkable areas + blockers   ------------+------> |  can this move happen? (rules)    |
  |  seats / desks / chairs (anchors)        |        |  who can hear whom (proximity)    |
  |  zones (rooms/islands) + their rules     |        |  seat claims, travel/jump         |
  |  projection (flat -> 2.5D screen)  ------+--+     +----------------------------------+
  +------------------------------------------+  |
                                                |     +----------------------------------+
                                                +---> |  RENDERER: draws the art, puts    |
                                                      |  avatars in the right place and   |
                                                      |  in front of/behind things        |
                                                      +----------------------------------+
```

**What this means for the product**
- A customer picks a template, and can adjust seating and names without engineers.
- Different templates can have very different shapes, seat counts and people arrangements, and everything (audio, search, jump, live count) still works.
- Making the art and making the "walkable and seat" data are two separate jobs, and the second one needs a small authoring tool (section 9).

---

## 1. What a template is

A template is one versioned package. Everything the engine and the screen need lives inside it.

| Part | What it holds | Who makes it | Used by |
|---|---|---|---|
| **Art layers** | Background picture, foreground pieces that can hide avatars (arches, trees), room thumbnails | Designer / art | Renderer only |
| **Walkable map** | Areas you may stand in (islands, bridges, floors) and blockers (walls, edges) | Template author | Server (rules) and client (prediction) |
| **Anchors** | Every seat, desk, chair, sofa, stage spot: id, position, facing, type, which zone | Template author | Seats, spawn, jump, rendering |
| **Zones** | Each room/island: shape, name, badge, tagline, capacity, kind, audio rules, access rule | Template author | Audio, search, room list, live counts |
| **Links** | Bridges/portals between areas, and each zone's entry point | Template author | Travel/jump, later sharding |
| **Projection** | The math from flat position to 2.5D screen position, plus height per area | Template author + engineer | Renderer |
| **Rules of use** | Recommended capacity, seat mode (hot-desk, assigned), spawn rule | Product | Join, seating |
| **Manifest** | Name, version, checksum, author, licence, size limits | Tooling | Registry, safety checks |

**Example (shortened, illustrative):**
```json
{
  "id": "cosmic-canopy", "version": "1.0.0",
  "unit": { "tilePx": 160 },
  "walkable": [ { "id": "island-nexus", "polygon": [[...]], "height": 2 },
                { "id": "bridge-1", "polygon": [[...]], "height": "ramp:2->1" } ],
  "zones": [ { "id": "nexus", "label": "The Nexus", "badge": "NX", "tagline": "People, Events, Ideas",
               "kind": "stage", "capacity": 40, "polygon": [[...]], "entry": [1200, 800],
               "access": "open", "audience": true } ],
  "anchors": [ { "id": "nexus-seat-017", "kind": "chair", "at": [1180, 840], "facing": 90, "zone": "nexus" } ],
  "projection": { "type": "isometric", "angleDeg": 30, "origin": [960, 200], "heightPx": 48 },
  "seating": { "mode": "hot-desk", "spawn": "zone-entry" }
}
```

### How this relates to what we have (found by reading the code)
- `RoomLayout` in `packages/shared/src/layouts/types.ts` is already the seed of this: a floor, `zones`, `seats` with `anchor` points, `furniture`, and a `spawnZoneId`. Its own comment says a layout describes what the office looks like and never how many people may enter, which is the same separation we want.
- `registry.ts` maps a layout id to a hard-coded layout. **This becomes "load a template by id and version from the template registry".** The rest of the engine already asks for a layout by id (`parseRoomConfig` reads `Room.config`).
- **Gaps:** the floor is one rectangle (a template needs irregular areas with empty space between them), zones are tile rectangles (a template needs polygons), capacity is advisory only, furniture is drawing only with no collision, and there is no art or projection at all.

---

## 2. How a person's location is mapped (the core of the question)

There are **three coordinate worlds**. Keeping them separate is the point.

| World | What it is | Who owns it | Example |
|---|---|---|---|
| **Logical** | Flat 2D map in fixed units (px, 160 px per tile). This is the truth. | Server | Ana is at (1180, 840) |
| **Zone/seat** | Which zone and which anchor that position belongs to | Server, derived | zone "nexus", seat "nexus-seat-017" |
| **Screen** | Where the art is drawn on your display | Client, derived | (742, 391) on screen, drawn in front of the arch |

**Step by step, for one person**
1. **Join.** The server chooses where you start from the template's spawn rule: your assigned seat, your last seat, a zone entry point, or a spawn ring. The result is a logical position.
2. **Move.** Your client sends logical positions. The server checks the move: is it inside a walkable area, not through a blocker, and not faster than allowed? (Speed check exists today. Walkable check is new.)
3. **Derive.** The server works out your zone (polygon test) and, if you sit, your seat. Proximity and audio use the logical distance plus the zone's rules, exactly as now.
4. **Draw.** Every client turns every logical position into a screen position with the template's projection, sorts avatars front to back, and hides them behind foreground art where needed.
5. **Sit.** Clicking an anchor claims that seat: your position becomes the seat's anchor, you face its direction, and the seat is marked taken. Standing up releases it.

**Why this survives any template:** different templates change only the walkable map, the anchors, the zones and the projection. Steps 2 to 4 are the same code.

**Consistency rule (important for design and QA):** every template must use the same real-world scale, so a person-to-person distance means the same thing everywhere. Today that is 160 px per tile, full audio within 200 px, fading to silence at 500 px. A template that is drawn at a different scale declares a `unit` and the tooling rescales it. Islands that should not hear each other must be laid out more than 500 px apart, or be separated by a zone rule (see section 6).

---

## 3. Seating and people arrangements (why templates can feel different)

A template chooses a **seating mode**. The engine supports all of them.

| Mode | Meaning | Good for | Exists today? |
|---|---|---|---|
| **Free roam** | Nobody is assigned, people stand or walk anywhere | Social spaces, events | Yes |
| **Hot desk** | Claim any free seat, only when close to it | Open offices | Yes (`seat:claim`, 120 px range) |
| **Assigned desk** | A seat belongs to a person and is theirs every day | Teams, "my place" | **No.** Needs a stored assignment |
| **Zone assigned** | You belong to an island or team area, seat chosen on arrival | Departments | **No** |
| **Reserved / event** | Seats held for a session (webinar, town hall) | Events in a stage zone | Partly (stage/audience audio exists) |

**Where people start** is a template rule too: `assigned-seat`, `last-position`, `zone-entry`, `spawn-ring`. So "this template has people organised by team around desks, that one has everyone in a big dome" is data, not code.

**Customisation (proposed):** a customer can change names, move or add seats, and set the seating mode inside limits the template allows. These are stored as **overrides** on their copy of the template, so the original template stays clean and can be upgraded.

---

## 4. Mapping the current architecture to the target

| Current piece | Where | Stays / changes | Change needed |
|---|---|---|---|
| Layout data | `packages/shared/src/layouts/types.ts` | **Grows** | Polygons for floor and zones, elevation, links, projection, richer anchors. Keep `RoomLayout` as the compiled form the engine reads |
| Layout registry | `layouts/registry.ts` | **Replaced by** | A template registry (database + files) with versions. Same `resolveLayout` shape, loads validated JSON |
| Which layout a room uses | `Room.config` (`parseRoomConfig`) | **Grows** | Points at a template id + version + this customer's overrides |
| Zone lookup | `zoneAt` in `queries.ts` (tile rectangles) | **Changes** | Point-in-polygon with a spatial index |
| Move validation | `validateMove` in `packages/proximity/src/movement.ts` (speed, room bounds, burst credit) | **Grows** | Add "inside walkable area, not crossing a blocker". Speed logic untouched |
| Proximity and audio | proximity engine, `zoneAudio.ts`, zone overrides | **Stays** | Zone rules come from the template. Add per-zone access |
| Seats | `roomManager.claimSeat`, `seatOccupancy.ts` | **Grows** | Assigned modes, facing, persistence of assignments |
| Travel / jump | not built (only seat teleport) | **New** | Checked travel to a person, a zone entry, or a seat |
| Room occupancy and live count | `occupancy:update`, plan limits | **Grows** | Per-zone counts and a workspace-wide live count |
| Search and directory | not built | **New** | Presence index for "Find a person or room", People and Rooms tabs |
| Drawing | `apps/web/src/canvas/PixiStage.ts` | **Grows** | Art layers, projection, depth sorting, culling, zoom levels |
| Event batching | Phase 18 `proximity:batch` | **Stays, key for scale** | Measured: burst 23 ms to 1.6 ms at N=100 |
| Audio transport | LiveKit, selective subscription | **Stays** | Proposed: one LiveKit room per space, with selective subscription as now (to confirm with the audio owner) |
| Load harness | `loadHarness.ts` (spread, cluster) | **Grows** | A "seated-heavy" scenario placed from a template's seats (section 7) |

---

## 5. What gets stored (proposed)

| Store | New data | Notes |
|---|---|---|
| **Database** | `SpaceTemplate` (id, name, owner, licence), `TemplateVersion` (semver, package location, checksum, validated flag), `Space` (a customer's live space: template + pinned version + overrides), `SeatAssignment` (space, seat id, user, mode) | `Room` can become the `Space`, or point to one |
| **File/object storage** | Template packages: art layers and the JSON | Content-addressed by checksum so a version never changes |
| **Redis** | **Presence**: user to `{space, zone, seat, status}`, updated on join, leave, zone change and seat change, **not** every tick | Powers search, People and Rooms tabs, live count |
| **Memory (server)** | Compiled layout: polygons, spatial indexes, anchor table | Built once when a room starts |

---

## 6. Runtime flows

**Join.** authenticate, resolve the room, load the pinned template version, compile it, pick the start position by the spawn rule, admit, and tell the client the template id and its projection so it can draw.

**Move.** as today, with the extra walkable check. A rejected move sends the usual correction.

**Sit / stand.** claim an anchor, occupy it, set position and facing, tell others. Assigned seats skip the "must be close" rule for their owner.

**Travel (the "instant jump" you asked for).** One checked request with three kinds of target: a person, a zone (its entry point), or a seat. The server picks a free landing spot (about 120 px from a person, inside the walkable area), releases your current seat, resets your movement allowance, and enforces zone access and a short cooldown. Search results, room labels, avatar clicks and desk clicks all send this same request. **Zones with `access: private` refuse uninvited travel** (proposed default, your call).

**Audio between areas.** Proximity works as now. Zone rules decide the rest: a focus island can mute outsiders, an event dome can send the stage speaker to the whole audience, a private cabin hears only its members.

**Switching template.** Existing users are re-placed by the new template's spawn rule. Seat assignments that do not exist in the new template are dropped and reported to the admin.

**Search and directory.** People tab and search read the presence index. Rooms tab reads zone counts. The live count is the sum of presence.

---

## 7. Scale: what we measured and what we must still prove

**Measured (Codespace, server and test clients on one machine)**
- N=100 everything passing, and Phase 18 batching cut the post-tick burst from about 23 ms to 1.6 ms and the event-loop p99 from about 60 ms to about 25 ms.
- Before batching, N=200 failed its tick and event-loop gates (tick p95 about 65 ms). **N=200 has not been re-measured with batching. N=500 has never been run.**

**Correction (2026-09-21): the earlier "seated" people were never seated.** The server seats someone only within 120 px of the seat (`out_of_range` otherwise), and the load test sent every seat claim from the arrival spot without reading the replies. With the replies counted, 0 of 90 claims were accepted. So the earlier runs had about half the people standing still at the arrival spot and the rest wandering: not "everyone walking constantly", and not seated. The test now prints how many claims the server accepted, and `LOAD_HARNESS_WALK_TO_SEAT=1` walks each person to their seat first.

**Measured after the correction** (N=100, spread, 60 s, batching on, one Codespace, no tunnel; 90 people seated and accepted by the server, 7 walking, 7 reconnects; the old office `openOffice@1` against the map `spatialMap@1`):

| | old office | map (`spatialMap@1`) | earlier runs, nobody seated |
|---|---|---|---|
| seats accepted by the server | 90 of 90 | 90 of 90 | 0 of 90 |
| tick p95, worst interval | 14.5 ms | 15.9 ms | about 9.4 ms |
| event-loop p99, worst interval | 14.4 ms | 15.3 ms | about 19 ms |
| move corrections | 0.012% | 0.024% | 0.036% |
| proximity updates in the window | 14,130 | 83,518 | 186,290 |
| memory growth check | passed (+14%) | failed (+24%) | failed (+23% to +32%) |

All other gates passed in every run. The old-office run was made on a server that had already run one test, so it is not a clean like-for-like with the map run (which was on a fresh server). The memory check failed on every fresh-server run and passed once on a warmed-up server; that fits warm-up but does not prove it, and a 10-minute run is needed before calling it either way.

**Not measured yet:** everyone walking on the map floor, N=200 and N=500 with seats, and any real browser.

**Design choices that keep the door open (proposed)**
- **Regions.** Templates mark their separate areas (islands) and the links between them. Version 1 runs all regions in one server room. If we need more capacity, regions become the unit we can split across servers, with a hand-off at the bridges. Cost of adding the region graph now is small. Cost of adding it later, after many templates exist, is large.
- **Interest management.** For large rooms, send each client full-rate updates only for what it can see, and low-rate summaries for the rest.
- **Map view.** The zoomed-out "Map" tab does not need every avatar in detail. It can use a once-a-second summary per island, with detailed updates only for the island you are looking at.

---

## 8. The team, one view each

### CEO / business owner
- **Why:** templates are the product's difference. Customers get their own place, not a generic grid.
- **Decide:** who may create templates (us only, approved partners, any customer), whether templates are sold, and the first capacity promise (200 is plausible, 500 is not yet proven).
- **Success measures:** time from sign-up to "I am at my desk talking to someone", how often people use search and jump, concurrent people per space, templates made per month.
- **Watch:** art production cost and time, and the risk of promising a capacity we have not measured.

### Product manager
- **Core stories:** "I arrive at my own desk." "I find Priya and I am next to her in one click." "I see which rooms are busy." "My admin changes our layout without a developer." "I switch template and nobody is lost."
- **Flows to write down before build:** join, find a person, jump, sit, switch template, private room, admin edits seats.
- **Deliverables:** requirements per phase, acceptance tests in plain language, the list of things we are deliberately not doing.

### Designer (product and art direction)
- **Art rules to publish:** view angle and scale, how walkable and non-walkable areas must read visually, how seats look when free and taken, what is allowed to hide an avatar.
- **UX to design:** People, Rooms and Map tabs, search, live count, zoom and "My Location", room label cards, seat and avatar states, what you see when you jump, light and dark, colour-blind-safe cues, avatar legibility at each zoom level.
- **Deliverables:** art brief and template spec, screen designs, and an interaction spec for jump and travel.

### Engineering (technical team)
- **Realtime and backend:** template schema and validator, polygon zones and walkable check, seat modes and assignment persistence, travel, presence service, projection-agnostic engine.
- **Web and graphics:** projection and depth sorting, layered art rendering, culling and zoom levels, the tabs and search, click targets for avatars and desks.
- **Audio:** keep LiveKit selective subscription, define per-template zone audio rules, decide one LiveKit room per space.
- **Platform and SRE:** template storage and versioning, feature flags, dashboards per template, capacity plan, rollout and rollback.
- **Tools:** the Template Studio (section 9) and command-line validator.
- **Rule we keep:** measure first, one run, report, then decide. No tuning on suspicion.

### QA / tester
- **Template validator tests (automatic, run on every template):** every seat inside a walkable area and reachable from spawn, no two seats on the same spot, every zone has an entry point, all regions connected by links, capacity is a separate number from the seat count (a 2-seat room may allow 4 people; capacity is checked against seats only for a zone that declares `seatsRequired`), private zones far enough apart for the audio radius, file size and shape limits.
- **Engine tests:** walkable rejection, polygon zone membership at edges, seat claim in all modes, travel (each target type, refusal cases, cooldown, seat release), projection round trip (flat to screen and back within one pixel), depth ordering.
- **Load tests:** 100, 200, 500 people per template with the seated-heavy scenario, plus reconnect storms and jump storms.
- **Visual regression:** a screenshot per template at each zoom level.
- **Manual script per release** (like the one we ran): two windows, walk, sit, jump, search, private zone, switch template.
- **Compatibility:** older browsers, small screens, keyboard-only use, slow connections.

### Security and privacy
- **Uploaded templates are untrusted files.** Size limits, image checks, schema validation, no script content.
- **Private zones** must be enforced by the server for movement, jump and audio, not only hidden in the interface.
- **Jump abuse:** cooldown, no jumping into private or full zones, and an audit trail of who jumped where.

### Support and growth
- **Template picker and preview,** guided setup, and a "restore original layout" button.
- **Admin controls:** assign or clear seats, rename zones, choose the seating mode.
- **Messages people will see:** "That room is private", "That room is full", "Person has left".

---

## 9. The missing tool: a Template Studio

The pictures will be made by artists or AI. The **walkable map, seats and zones cannot be guessed from a picture reliably**, so someone must mark them. This needs a small web tool:
1. Upload the art. Set the view angle and scale.
2. Draw walkable areas and blockers on top of the picture.
3. Click to place seats and desks, set their type and direction, group them into zones.
4. Set zone names, badges, capacities, rules and entry points.
5. Run the validator (section 8, QA) and preview with test avatars walking and sitting.
6. Publish a versioned package.

Until the Studio exists, the first templates can be authored as JSON by an engineer with a preview page, so the engine work is not blocked.

---

## 10. Phases (each with evidence gates)

| Phase | What we build | Done when |
|---|---|---|
| **19. Travel logic** | The checked jump to a person, zone or seat, with tests. No screens. | Tests pass, including refusals. Works on today's layout |
| **20. Template schema v1** | Define the package format and validator. Convert `openOffice@1` into it with **no behaviour change** (structural commit first) | Old and new layouts behave identically in the existing test suite |
| **21. Walkable areas and polygon zones** | Server rules and client prediction for irregular floors | Off-island moves rejected. Zone edge tests pass |
| **22. Projection and layered rendering** | Render a stand-in 2.5D template: art layers, depth sorting, zoom levels | Avatars sit correctly on the art in every zoom level. Projection round-trip test passes |
| **23. Seating modes and start rules** | Assigned seats, persistence, spawn rules, facing | People land at their own desk on join. Reconnect keeps the seat |
| **24. Presence, search and tabs** | Presence index, People, Rooms and Map tabs, search, live count, My Location, zoom buttons | Search finds a person and the jump lands next to them. Counts match |
| **25. Scale proof** | Seated-heavy load scenario at 200, then decide on interest management and 500 | Measured numbers, one run at a time, gates reported honestly |
| **26. Template Studio and versioning** | The authoring tool, publish, upgrade and pin versions, customer overrides | A non-engineer makes and publishes a template. Live spaces upgrade safely |

Phases 19 and 20 are independent of the art and can start now. Phase 22 needs at least one real 2.5D template image.

---

## 11. Decisions we need from the product owner

1. **One server room or one per island for version 1?** Recommendation: **one room**, with regions marked so we can split later.
2. **Who creates templates at launch?** Us only, partners, or customers. This decides how much validation and safety work is needed first.
3. **Are seats assigned to people, hot-desk, or both?** The picture implies "their own place", which needs stored assignments.
4. **Private and invite-only areas:** are jumps into them blocked, or do they ask permission first? (Proposed default: blocked.)
5. **First capacity promise:** 100 is proven, 200 is plausible, 500 is unproven. What do we tell customers?
6. **Template art:** AI-generated, commissioned, or both, and who owns the licence?
7. **Names and branding:** logo and company name are undecided, so the top bar stays a placeholder that reads a per-workspace logo and name.

---

## 12. Glossary (plain words)

- **Template:** the package that describes one kind of space: art plus where you can walk, sit and hear.
- **Engine:** the code that moves people, checks rules and works out who can hear whom. It is the same for every template.
- **Anchor:** an exact spot in the template where something belongs: a seat, a desk, an entry door.
- **Zone:** an area with its own rules and name, such as a room or an island.
- **Walkable map:** where a person is allowed to stand.
- **Projection:** the math that turns a flat position into the tilted 2.5D picture.
- **Presence:** the live list of who is online and where, used for search and counts.
- **Region:** a separate area, such as an island, that could later run on its own server.
- **Hot desk / assigned desk:** take any free seat, versus a seat that is yours.
- **Interest management:** sending each person only the updates they can actually see.

---

## 13. Reviewed build plan: the first template, end to end

Outcome of the engineering review of sections 0 to 12. The eight generic phases in section 10 are replaced, for now, by **one vertical slice**: build a single hard template completely with hand-written data, and generalise only what it forces. The Studio, versioning, customer overrides, region splitting and the marketplace are deferred until this slice works.

### Decisions taken in the review
| # | Decision | Chosen |
|---|---|---|
| Scope | Build order | One template, end to end, hand-written data. Generalise afterwards |
| 1A | Walkable rule | **One shared pure function** used by server validation and the browser's movement, sliding along island edges, rejecting a straight path across empty space, with agreement tests over thousands of random moves |
| 2A | Avatars behind objects | **A depth map for the whole picture** (chosen against the recommendation of "always on top in v1"). Consequence: every template needs a depth image, and we need a way to produce and check it |
| 3A | Art for the first template | The look and layout of the reference picture, **built light**. Working reading, to be confirmed: stand-in art generated from shapes in the same layout (islands, bridges, seats, zones), so walkable areas, seats and the depth map are exact. The real picture can replace it later |
| 4A | Rendering cost | **Draw only when something changes**, tiled compressed art, the depth map **compiled at build time into a few cut-out layers** (no per-pixel depth maths on the user's machine), capped resolution, dots when zoomed out, pause when hidden, and a **tested CPU and frame budget** |

### Why 4A matters (found by reading the code)
`apps/web/src/canvas/PixiStage.ts` runs a permanent per-frame callback (`app.ticker.add`, line 194) with anti-aliasing on and no idle mode or frame cap, so the canvas redraws every frame even when nothing moves. Adding large art to that loop would make it the heaviest thing in the app. The slice replaces it with a loop that runs only while there is something to draw.

### Build pipeline for a template (proposed)
```
  compact description (islands, bridges, seats, zones, heights)
            |
            v
     template builder (command line, the first version of the Studio)
      |            |             |               |
      v            v             v               v
  template.json   art tiles   depth map ---> cut-out layers   validator report
  (walkable,      (compressed) (exact for      (few masks,     (seats reachable,
   seats, zones,                stand-in art)   cheap at run    zones closed, etc.)
   projection)                                  time)
            \________________ package, content-hashed ________________/
                     |                                  |
                     v                                  v
              SERVER (rules, flat 2D)            BROWSER (drawing, 2.5D)
```

### The slice, in order
| Step | What | Done when |
|---|---|---|
| **S0 (structural commit first)** | Template package v0: a validated JSON shape, a loader, and today's `openOffice@1` expressed in it with **no behaviour change** | Existing test suite passes unchanged |
| **S1** | Shared geometry: point in polygon, segment against polygon, `moveWithinWalkable` (slides along edges), a polygon complexity cap and a grid index | Property tests pass: results are deterministic and independent of server or browser |
| **S2** | Server: walkable check in move validation, polygon zone lookup, seat facing, spawn at an assigned seat or a zone entry | Off-island and across-void moves rejected. Zone edge cases pass |
| **S3** | Browser movement uses the same shared function | **Agreement test:** for thousands of random moves the browser's result equals the server's verdict. Correction rate at island edges is at baseline |
| **S4** | Template builder for the stand-in template: shapes to JSON, tiles, depth map, cut-out layers, validator | Builder output validates and is byte-stable across runs |
| **S5** | Renderer: isometric projection, tile loading, draw-on-change loop, depth ordering with the cut-out layers, dots at low zoom, resolution cap, pause when hidden | Avatars sit on the art and hide behind cut-outs correctly. Projection round trip under one pixel |
| **S6** | Travel logic: jump to a person, a zone entry or a seat (checked, seat-releasing, cooldown, private zones refused by default) | Tests for each target and each refusal |
| **S7** | Minimal screens: online list with click to jump, live count, zoom buttons, My Location. Search and full tabs come from the design image later | You can jump to a person and see the count |
| **S8** | Measure: render budget script (idle, walking, zoomed out; reference laptop and phone) and a **seated-heavy load scenario** placed on the template's real seats at 200 | Numbers reported, one run each. No tuning from a result |

### Test plan
```
[+] shared geometry (S1)
  ├── point in polygon: inside, outside, on an edge, at a vertex, concave, holes   unit + property
  ├── segment vs polygon: crossing void, tangent, along an edge                    unit + property
  └── moveWithinWalkable: slides, never ends outside, deterministic                property (many random moves)
[+] server (S2)   walkable rejection, zone polygons, seat facing, spawn rules, complexity cap       unit
[+] agreement (S3) browser result == server verdict over random moves at every island edge          property
[+] builder (S4)  reachability of every seat, one entry per zone, regions connected, sizes capped    unit + golden files
[+] renderer (S5) projection round trip, depth ordering, draw-on-change (no frames when idle)       unit + visual regression
[+] travel (S6)   person / zone / seat targets, private refusal, cooldown, seat release             unit + real-socket seam test
[+] budget (S8)   CPU and frame time in idle / walking / zoomed out, reference laptop and phone      scripted measurement
```
Regression rule: S0 must leave every existing test green. S3 protects the Phase 16 rubber-banding fix.

### Failure modes to design for
| Path | Realistic failure | Handled by |
|---|---|---|
| Walkable rule | Browser and server disagree at an edge, snap-backs return | S1 shared function, S3 agreement test |
| Movement across gaps | A move that crosses empty space between islands passes an end-point check | Segment test, not only end points |
| Polygon cost | A huge polygon makes every move and tick slow | Complexity cap in the validator, grid index |
| Depth map | Wrong depth makes avatars flicker behind the wrong things | Exact depth for the stand-in, validator check, visual regression |
| Idle loop | The draw-on-change loop misses an update and the screen looks frozen | A test that every state change requests a frame |
| Battery | A change quietly raises idle CPU | S8 budget script gates the release |
| Template load | The browser cannot fetch or verify the package | Loading and error states, checksum in the join reply |

### Not in this slice
The Template Studio (the builder is its command-line seed), template versioning and customer overrides, the presence index and full-directory search, region splitting and multi-room hand-off, tiling and depth-mapping the real AI picture, per-plan template limits, N=500.

### Parallel work
```
Lane A (engine):   S0 -> S1 -> S2 -> S3            shared geometry, server, browser movement
Lane B (art/tool): S4 (needs the S0 format)        builder, stand-in template
Lane C (drawing):  S5 (needs S4 output)            renderer
Lane D (travel):   S6 (needs S2)                   jump logic
Then: S7 (needs S5, S6), S8 (needs S5, S7)
```
Lanes A and B can start together once S0's format exists. A and C touch different packages (shared/realtime versus web).

---

## 14. Design spec (from the design review)

Outcome of the design review of sections 0 to 13. It adds what people see and do. Every item here was decided individually. No screen pictures were generated: the design tool needs an OpenAI API key that is not configured, so the decisions below are backed by text sketches, not mockups.

Existing look to reuse (found in the code): dark ground `#0b0d12`, Tailwind, translucent black chips with blur (`bg-black/50 backdrop-blur`), blue dot for you, green dot for others, monospace counts. There are no design tokens and no `DESIGN.md` yet.

### Pass 1: what the user sees first, second, third
Screen type: a full-screen scene where the scene is the product (an "experience" screen), not a dashboard.

| Rank | Element | Why |
|---|---|---|
| 1st | The scene and your own avatar | It is the product |
| 2nd | Find and jump (search) | The main action |
| 3rd | Live count | Proof that people are here |
| Edge | Tabs, room list, zoom, My Location, logo | Small, at the edges, out of the way |

**Decision 1A: floating glass chips over a full-screen scene**, in **named slots**, so new controls take a slot and never a free position:
```
+--------------------------------------------------------------+
| top-left: (free)                          top-right: logo+name|
|                                                              |
|                 island scene, full screen                    |
|                                                              |
|                                          bottom-right: zoom, |
|                                          My Location         |
| bottom-left: Live count   bottom-centre: Find a person or room|
+--------------------------------------------------------------+
```
- The top-right slot belongs to the logo and company name, as in the reference picture. The current people list ([RoomHud.tsx](../../apps/web/src/components/RoomHud.tsx), top-right) and the zone chip ([ZoneHudChip.tsx](../../apps/web/src/components/ZoneHudChip.tsx), left, 24 units down) must move into slots when this is built.
- Every chip has a collapse or hide rule and a safe margin so it never hides an avatar the user is trying to click.
- The layout knows nothing about a particular template, so a new template or scene needs no layout change.

**Decision 1B: three fixed zoom levels**, each with one job:
| Level | Shows | Draw cost |
|---|---|---|
| **Map** (zoomed out) | Islands, dots, counts only | Lowest, fits the battery budget |
| **Room** (default) | Avatars with initials, room label cards | Medium |
| **Desk** (zoomed in) | Full names, seat labels, seat state | Highest per avatar, but few avatars are visible |
- A short cross-fade between levels, no per-frame label collision checks.
- QA takes one screenshot per level per template (visual regression).

### Pass 2: states (every feature has a loading, empty, error and partial look)

**Decision 2A: scene loading.** The builder also makes a tiny blurry preview of the whole scene (about 20 KB) per template. It shows at once, sharp tiles fill in over it, and the screen is never black. If the template cannot load: a failure screen "Couldn't load this space" with **Try again** and **Back to my last space**. A checksum mismatch is treated as a load failure.

**Decision 2B: jump refusals are shown on the row before the click**, with the reason, and a short message appears only if the state changed after the click ("Ana just left"). The server enforces the same rules either way. The reasons come from the **template's per-zone rules**, not from fixed code:
| Reason shown | Comes from |
|---|---|
| Full (12/40) | The zone's `capacity`. **Capacity is its own number, not the seat count**: a 2-seat room may allow 4 people |
| Private, invite only, interview room | The zone's `access` rule |
| In a meeting, occupied | A **new live zone state** (`open`, `occupied`, `locked`) that the server tracks. This is new engine data the travel step (S6) needs |
| Away, offline | Presence |
| Try again in 3 s | Jump cooldown |

**Decision 2C: the states table (adopted row by row).**
| Feature | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| Scene | Blurry preview at once, tiles fill in | n/a | Failure screen (2A) | Scene and you at your seat | Missing tiles stay blurry, retry quietly |
| Search | Skeleton rows after 150 ms | "No one called 'xyz'. Try a room name." plus the 5 busiest rooms | "Search is down. The People list still works." | Results, each with Jump | Only people or only rooms: show that group |
| Jump | Nothing under about 200 ms, then a small "Jumping..." | n/a | Reason on the row, message if it changed (2B) | You appear next to the target | n/a |
| People list | Skeleton rows | "You're the only one here." No invite link: you are already in the workspace | Last known list, dimmed | Rows | A scrolling list that draws only the rows that fit, nothing overlapping (no fixed cap) |
| Live count | "..." | "1" (you) | Last number, dimmed, "offline" | The number | n/a |
| Seat | n/a | Free seat outline | **No message.** Seats are visibly occupied and everyone can see who sits where | Avatar faces the desk, chip "Desk 017 - Stand up" | n/a |
| Connection | Existing "Reconnecting..." badge | n/a | Unchanged from today | Badge disappears | n/a |

**Seating on arrival (refines the spawn rule in sections 3 and 6):** on joining you are placed automatically at **your assigned seat, otherwise your previous seat if it is free, otherwise any free seat**. You can later move, or use a "back to my seat" action.

**Deferred by the user (next level after this one):** invite links and meeting rooms opened in a new window, like Zoom or Teams.

### Pass 3: the journey

| Step | User does | User feels | Specified by |
|---|---|---|---|
| 1 | Opens the space | Curious, impatient | Blurry preview at once (2A) |
| 2 | Lands at their own seat | "This is my place" | Assigned, then previous, then any free seat |
| 3 | Sees the count and avatars | Reassured | Live count, three zoom levels (1B) |
| 4 | Searches and clicks Jump | Wants speed | Reason shown on the row (2B) |
| 5 | Arrives next to the person | Connected | Instant cut, then a ring (3B) |
| 6 | The other person sees someone appear beside them | Possibly startled | **Accepted risk (3A)** |
| 7 | Goes back to their seat | Relief | "Back to my seat" |
| 8 | Returns tomorrow | Familiar | Previous seat remembered |
Time horizons: 5 seconds = the preview and your own avatar at your seat; 5 minutes = find someone and reach them; long term = "my place".

**Decision 3A: a jump to a person is always instant.** No arrival cue, no consent step, no "Ask first" setting. The risk that the other person is startled is accepted by the product owner. Rules that still apply: private, full and occupied zones refuse (2B), the cooldown, and the audit trail of who jumped where (section 8).

**Invite to talk (a later feature, not in S0 to S8).** If someone you jumped to did not respond, you go back to your seat and send an invite. When they return and accept, you talk. It needs a stored pending invite and a notification. Its place in the phase order is an open decision (Pass 7).

**Decision 3B: an instant camera cut to the new place, then a highlight ring around you for about 300 ms.** No slide or fly-across, so the jump costs almost no drawing work.

### Pass 4: an intentional look, not a generic one

Screen type: the main screen is an "experience" screen (the scene fills the view); lists and panels are ordinary app screens. No hard-rejection pattern applies. Known gap: the logo and company name are undecided, so the top-right slot is a placeholder that reads a per-workspace logo and name.

**Decision 4A: quiet, neutral controls with one accent colour, and the scene carries the colour.** The controls must not depend on any one template's look. The "Cosmic Canopy" picture is only one example template, so nothing in the controls is styled to match it. Keep the dark glass chips already in the app because they stay readable over busy art. No glow, no gradient edges on controls. A template may supply an accent hue through its data.

Watch list for reviewers (AI-look tells): a system font as the main face, glow or gradient edges, purple-to-blue gradients, and identical rounded cards everywhere.

### Pass 5: design system

**Decision 5A: a small token set plus a one-page `DESIGN.md`, with a real font pair swappable in one place.** Today there is no `DESIGN.md` and no tokens: colours are typed into components and the font is the plain system one ([globals.css:13](../../apps/web/src/app/globals.css)).
- **Tokens** (each defined once, as CSS variables): colours (ground, chip surface, text, muted text, one accent, "you" and "other" dots), corner roundness, blur amount, spacing steps, type sizes, motion timings (ring 300 ms, level cross-fade).
- **Fonts:** a real UI face plus a number face for counts, replacing the system font. It is replaceable in one line when the brand is decided. The font download is counted in the loading budget.
- A template may supply its own accent hue through its data. The controls pick it up from the token, with no restyling.
- `DESIGN.md` records decisions 1A to 5A so later work has one place to look.
- Pass 5 status: this design review was paused after 5A, before Pass 6 (phones and accessibility) and Pass 7 (open decisions). Neither has been done.
