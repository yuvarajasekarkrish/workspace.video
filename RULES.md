# Rules for building map assets (desk, chair, laptop, and anything after)

Written down because these keep getting missed. Every rule below came from a real correction the owner
gave during this work — nothing here is invented. Read this whole file before touching any new asset,
not just skimming the part that seems relevant.

## 1. Workflow order — never skip a step

1. **Picture first.** Never write any implementation code (anything in `apps/web/src/canvas/*.ts` or
   elsewhere) until the owner has explicitly approved a picture of it.
2. **One item at a time.** Don't move on to the next item in a list (desk, then chair, then laptop,
   then plant, then the next seating block) until the current one is approved.
3. **No repeated "do you approve?" prompt.** Show the picture and stop. Don't ask after every picture —
   the owner brings feedback on their own timing.
4. **Nothing is locked in until the owner explicitly says so.** A related comment, a new question, or
   silence is never approval. Only a clear "yes / approved / go ahead" unlocks writing code.
4a. **Every decision the owner approves gets written down here, the same turn.** Whenever the owner
    raises an idea and then says it's good/approved/right, that becomes a new rule in this file before
    moving on — not just acted on once and forgotten. From then on, check new work against it like any
    other rule in this list, and if a future picture violates it, that's a bug the same as breaking any
    rule above.

## 2. Always check the real layout before making or describing anything

5. **Compare against the real, already-built layout every time — not just sometimes.** Before drawing
   or describing a seat, desk, or block, check what the actual code already builds for that exact
   thing (`packages/shared/src/layouts/modules.ts`, `openOffice.ts`, and how `FloorView.ts` draws it
   today). Show a side-by-side: what the real code draws today, next to the new version.
5a. **Strict: any artifact built to match a real product page or real code must show that comparison
    on the artifact itself, every time — never just checked privately and asserted in words.** If a
    board claims to reuse a real formula (e.g. the table's `roundRect` radius, a real size or spacing
    value), the board must visibly show the real reference next to the new one, labelled, so the owner
    can check it with their own eyes — not just take a written claim that it matches. A board with no
    real thing to compare against (like the laptop, which has no real code yet) must say so plainly on
    the board instead of comparing against nothing. This applies to every future artifact, not only the
    room-canvas ones already covered by rule 5.
6. **Check every real variant before assuming one.** A desk, table, or block might have more than one
   real shape (2-seat desk vs 4-seat bench table vs 20-seat meeting table are genuinely different
   things in the code). Search the actual layout code for every variant that exists and confirm with
   the owner which one is meant — never invent a shape that "seems reasonable."
7. **A chair image is a visual swap, not a new placeable object.** Chairs are already positioned by a
   fixed formula in `modules.ts` (e.g. `deskGrid`'s `chair-a`/`chair-b`, exactly two seats per desk,
   always). Replacing the plain circle with a picture never changes how many seats exist or where —
   it only changes what's drawn at the same fixed spots. Do not treat the chair as something the admin
   places independently.
8. **New seating types reuse existing real shapes only.** A "4-seat" block is the real `benchTable`
   (a square table, one chair on each side) — not an invented shape. Any new block must be built from
   a shape that already exists in `modules.ts`, or the owner must explicitly say a genuinely new shape
   is wanted.
8a. **Before replacing or verifying any asset in the real code, check the Artifact board first.** If a
    coded board already exists for that exact seat/block (e.g. `ChairCoded`, `FourSeatTableCoded`), use
    what it already proved instead of re-investigating from scratch by hunting through screenshots of
    the real app. The artifact work already established the correct shape, position and rotation —
    don't redo that verification a second time by a different, slower method. Only go looking in the
    live app when no artifact already covers the thing being checked.

## 3. Stay inside the workspace's own look

9. **Never replace the existing workspace canvas.** `FloorView.ts` already draws every piece of
   furniture as simple flat shapes. New work only adds detail on top of what's there — never a rewrite
   or a different rendering approach.
10. **Only the workspace's own existing colours.** Charcoal panel, white outline, slate chair
    (`CHAIR_FILL` / `PERSON_SLATE` — the same Tailwind "slate" family already in `palette.ts`), green
    plant. **No amber, no glow, no new hue.** Amber belongs to the landing page (the Gemini design)
    and, inside the room, only to the local user's own dot, a selected object, an occupied seat, and
    sofas — never a general "futuristic" accent for desks/chairs/etc.
11. **Lightweight, not photorealistic, unless the owner explicitly overrides this.** No heavy 3D
    rendering, gradients, or glow by default. A 2.5D flat-shaded look (a top face + one tilted face,
    same tilt language as the rest of the map) is the default target.

## 4. Correctness of what's actually drawn

12. **Every seated person needs their own version of whatever sits on a shared surface.** A 2-seat desk
    needs 2 laptops (one per person), not one decoration for a single side.
13. **Orientation must make physical sense.** A laptop's keyboard sits closest to the person using it;
    the screen stands between the keyboard and the desk's open space, tilted to face that person — not
    floating in the middle, not backwards.
14. **Every chair must face its table/desk, and every laptop must face its chair — proven per rotation,
    never assumed.** Armrests are on both sides of every chair, so they never tell front from back;
    don't use them as the check. The only real definition:
    - **Chair front** = the direction from the seat's position toward the centre of the table/desk it
      belongs to.
    - **Laptop near edge (keyboard)** = the direction from the table/desk centre outward toward the
      chair that uses it — the opposite of the chair's front direction.
    - Before placing a rotated copy of an approved chair or laptop image at a new seat, first work out
      which real-world direction that image's *unrotated* (0°) version already points (using the
      original approved reference photo it was cut from — never guessed), then measure, with actual
      pixel data (e.g. tracking the keyboard's or screen's centroid through each 90° step), exactly how
      that direction moves under rotation. Only then compute the rotation each seat needs. Two
      different source images almost never share the same 0° direction or the same rotation math — redo
      this check for every new asset, don't reuse a rotation table from a previous one.
    - **Seats directly across a table from each other sit on one straight line through its centre** —
      e.g. north and south seats share the same x, east and west share the same y — and face each other.
    - Check this on every seat of a new picture before showing it, not just the first one. A picture
      where two of four seats face the wrong way is exactly the kind of mistake this rule exists to catch.
15. **Match the reference the owner gives, as closely as the tools allow — and say so honestly when
    they don't.** Hand-typed SVG coordinates cannot reproduce a photo pixel-for-pixel; if the owner
    wants that level of match, the correct answer is to use their actual reference image directly (see
    rule 17), not to keep re-guessing coordinates.

## 5. Scale and future-proofing

16. **Design for every real plan size, not a convenient example.** Real plan sizes today are 10, 25,
    50, 100, and 200 people (`packages/shared/src/plans.ts` — capped at 200 on purpose; there is no 500
    yet). A seating/capacity idea must work at both the smallest and largest real size.

## 6. Once an image is approved, treat it as the source of truth

17. **An approved image is the exact asset — not a starting point to redraw from memory.** Once the
    owner approves a specific picture (or supplies their own reference photo and says to use it), reuse
    that exact file (or an exact crop/composite built only from that same file) for every related piece.
    Do not quietly substitute a hand-drawn approximation of it later.
18. **Reuse approved pieces instead of re-inventing them.** When building a new seating block (e.g. a
    4-seat table), reuse the already-approved chair and laptop images directly (resized/rotated as
    needed) rather than drawing new ones.
19. **Never silently swap an already-approved look for a new one.** If a new visual style is created for
    something that already has an approved look (e.g. a new higher-fidelity desk pod), the existing
    approved asset stays exactly as it is, in use, by default. The new one becomes an additional choice,
    not a replacement — see rule 20.
20. **Any new visual variant must become a real, selectable option in the admin builder — not just a
    hardcoded swap.** When a new furniture/desk/room style is approved, it is not enough to change what
    the one default layout draws. It has to be built so an admin can actually choose it (or the existing
    look) for their own workspace, once the admin builder exists to offer that choice. Until the builder
    exists to expose it, a new approved style is built to be selectable later, not wired in as the new
    silent default.

## What "add detail" is scoped to, and what it is not

This whole effort is about how existing, already-tested furniture (desk, chair, table, etc. — the 9
real seating blocks in `modules.ts`) *looks*. It does not change how many people a room holds, and it
does not build the admin builder's UI itself — but per rule 20, every new visual option this work
produces must be built as something that builder can eventually offer, not a one-off replacement of
what's there today.
