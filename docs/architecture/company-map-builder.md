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

**D1. Where a company's map lives.** In the room's existing settings column as `config.map`: a list of areas and a version number. No database change. The workspace and its first room are still created together, as today, from a starter map. The admin panel edits the map; there is no separate "create room, then workspace" order.

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

**D4. Who may edit.** Owner and admin only, checked on the server every time a map is saved. A member gets a refusal, not a hidden button.

**D5. When an edit goes live.** Each save makes a new version. A room that already has people keeps its current map until it next empties, because the server holds the layout for as long as anyone is inside. The admin panel says so. "Apply now" (asking everyone to reconnect) is a later addition. This needs no change to the engine.

**D6. The map is untrusted input, so it is checked twice: when saved and when loaded.** Proposed limits, unmeasured above what we have tested (100 people, 105 seats): floor at most 50 x 50 tiles (8,000 px, the engine's own limit), at most 60 areas, at most 400 seats, names at most 60 characters, ids of letters, digits, dash and underscore only, meeting rooms and cabins must not overlap, at most one arrival area, and every area inside the floor. The map may hold more seats than the plan allows people online; the panel shows both numbers. The plan's limit on people online is unchanged and independent of the map.

**D7. A stored map that is broken must never silently change the office.** On load, a map that fails the checks falls back to the room's named layout (or the default office), and the reason is returned so it can be logged and the admin panel can say why. The existing "never brick a room" rule stays.

**D8. One place decides the layout.** A single function, `resolveRoomLayout(config)`, in the shared package, used by the server, the room page, the canvas and the zone chip. Today each does its own lookup by name; a custom map cannot be looked up by name, so those callers must take the layout itself.

**D9. Order of work protects existing users.** New workspaces keep the old office until the new map screen exists, because the current flat canvas would draw a new-map room with no furniture. Nothing changes for anyone today.

## Build order (each step small, tested first, and stops for review)

| Step | What | Changes behaviour for existing rooms? |
|---|---|---|
| A | The map format, its checks, and `resolveRoomLayout` in the shared package (no screens). **Done, 2026-09-21** (`packages/shared/src/layouts/roomMap.ts`, 18 tests) | No |
| B | Server, room page, canvas and chip use `resolveRoomLayout` | No (same result for every room that exists) |
| C | Admin save: owner or admin only, checked, versioned | No (nothing calls it yet) |
| D | The map screen with real people and click-to-move. **Start with a measurement** of 100 moving people in a browser, on this design | Only for rooms on the new map |
| E | The builder in the admin panel | Only for admins |
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

## Not in scope (considered and deferred)

Assigned desks; jump to a person, area or seat; polygons and art templates; several rooms in one workspace; billing and plan changes; applying an edit to a live room; splitting areas across servers; 200 and 500 people with seats; anything on the engine or the proximity algorithm.

## Test plan

- **Shared (step A):** valid starter map accepted and equal to `spatialMap@1`; every rule in D6 refused with a clear message; unknown fields dropped; `resolveRoomLayout` gives the default for empty settings, the named layout for a known name, the custom map for a valid `map`, and the default plus a problem message for a broken one.
- **Wiring (B):** existing rooms resolve exactly as before; a room whose settings hold a custom map joins on it (real database); server and browser agree.
- **Admin save (C):** not signed in refused; a member refused; an owner and an admin accepted; invalid map refused with reasons; a stale version refused; a saved map is what the next fresh room uses.
- **Map screen (D):** the click and world round-trip; a person sits when walking to a seat and clicking; the 100-person browser measurement is taken once and reported before anything else is built on it.
