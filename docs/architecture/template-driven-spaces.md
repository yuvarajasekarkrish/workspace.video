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

**Important for the product (to test, not yet measured):** the earlier load tests made every simulated person walk constantly. In a template like the picture, most people are **seated** most of the time, and a seated person sends almost no movement and causes almost no audio changes. The real load may be much lighter than our worst-case tests. We must add a **seated-heavy scenario** that places people at a template's real seats with a small fraction walking and jumping, and measure that before promising 200 or 500.

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
- **Template validator tests (automatic, run on every template):** every seat inside a walkable area and reachable from spawn, no two seats on the same spot, every zone has an entry point, all regions connected by links, capacity not above seat count where seats are required, private zones far enough apart for the audio radius, file size and shape limits.
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
