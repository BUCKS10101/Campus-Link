# 3A — Location & Map Spec (persistent source of truth)

This document is the durable reference for Phase 3A's location/map/routing
work. **Whenever a future implementation decision changes an assumption
recorded here, update this document before changing the code.** It
supersedes nothing — `PHASE3_3A_ARCHITECTURE_PROPOSAL.md` and
`PHASE3_3A_ARCHITECTURE_REVISION.md` remain the design-rationale record;
this file is the current-state catalog and rulebook built on top of them.

## 1. 3A goal

Replace fabricated distance (`Math.random()`-based `distance_km`) with a
real, server-computed value over real campus geometry — and expand the set
of pickup/delivery points beyond the original ~31 hardcoded names into a
categorized, browsable catalog, plus support an arbitrary user-dropped pin
for destinations the catalog doesn't cover. No payments, no matching, no
notifications, no ratings, no social graph, no tip formula — 3A is
location/map/routing only.

## 2. MapLibre architecture

`src/components/map/CampusMap.tsx`, MapLibre GL JS v6 (BSD-3, no API key).
Lazy-loaded via `React.lazy()` — confirmed in its own build chunk, never in
the entry bundle. Renders only this project's own static GeoJSON (§3); no
basemap tile source is configured, so there is no tile provider to bill.

## 3. Static campus GeoJSON source

`public/campus-map.geojson` — 606 features (360 buildings, 246 footpaths),
extracted **once** via a direct read of the public Overpass API (OpenStreetMap),
committed as a static build asset. Served from our own build output at
runtime; nothing is fetched from any third party while the app runs.

**Known limitation, recorded here because it already caused confusion
once**: this specific committed file carries only `kind`
(`building`/`path`) and `highway` properties — no `name`/`amenity`/`shop`
tags. The richer, tagged data used to build the location catalog (§8-§10)
came from a *separate*, read-only Overpass query (full tags, same public
source, same bounding box) that was never written into this file or any
other repo file. If the map ever needs to render POI names as a vector
layer (not just markers), that tagged data would need a deliberate,
separate export — not assumed to already be present in
`campus-map.geojson`.

## 4. pgRouting walking-route architecture

`campus_path_nodes` / `campus_path_edges` — 916 nodes / 1013 edges, the
real OSM footway network for the campus bounding box, edge costs =
haversine distance between real consecutive path vertices. `pgr_dijkstra`
computes shortest path server-side. `compute_walking_route(pickup_id,
delivery_id)` returns real distance + route geometry + a simple ETA
estimate (distance ÷ 5km/h, explicitly an estimate). Falls back to
straight-line haversine (geometry: null) when a point isn't
graph-connected — never fails, never fabricates a route.

**3A-2 addition (this pass)**: a second entry point,
`compute_walking_route_custom(pickup_id, delivery_lat, delivery_lng)`, for
routing to a **custom pin** that isn't a `campus_points` row at all — see
§17/§18.

## 5. Live delivery tracking architecture

Supabase Realtime Broadcast, ephemeral (nothing persisted to any table).
Channel per order (`order-location-{orderId}`), authorized via RLS on
`realtime.messages`: deliverer publishes only while assigned and
`picked_up`/`out_for_delivery`; requester reads only their own order, same
state gate. Throttled (8s min interval), explicit opt-in on the deliverer
side, stale-after-30s handling on the requester side. Unchanged by this
pass — recorded here as a standing constraint, not re-litigated.

## 6. $0 cost requirement

Hard requirement, unchanged: no Google Maps/Routes billing, no paid tile
provider, no paid routing API, no subscription, nothing capable of
silently generating a charge. Everything in §2-§5 and the catalog
expansion below is either a one-time public-data read, a Postgres
extension, or an already-used Supabase feature (Realtime).

## 7. Privacy/security rules

- Campus point/catalog data: non-sensitive published reference data,
  readable by any authenticated user (RLS `using (active)`), no
  insert/update/delete policy for any role — rows are seed data managed by
  migration only.
- Custom pin data (§16): follows the **same authorization model as
  `delivery_location` today** — visible to anyone browsing the pending
  board (deliverers need to judge whether they can help before accepting,
  same as the existing symbolic location), then to the two order
  participants once assigned. This is an explicit decision, not an
  oversight: a custom pin's coordinates are plain columns on `orders`, so
  they inherit `orders_select_pending_feed` / `orders_select_participant`
  automatically — no new RLS policy was needed or added.
- A custom pin is **not** live tracking. It's a one-time destination
  chosen at order-creation time, stored on the order row, never updated
  after creation, never broadcast, unrelated to the Realtime mechanism in
  §5.
- Never exposed on Home, never exposed to non-participants, never treated
  as GPS.

## 8. Final location categories

Exactly seven catalog categories plus the custom-pin escape hatch, matching
the picker UI:

1. Food
2. Shops
3. Accommodation
4. Academic
5. Sports & Recreation
6. Medical & Health
7. Landmarks
8. Drop a pin *(not a catalog category — see §16)*

`campus_points.kind` is widened from the original 3-value enum
(`restaurant`/`hostel_block`/`campus_landmark`) to one value per category
above (`food`/`shop`/`accommodation`/`academic`/`sports`/`medical`/
`landmark`), migrating existing rows' values rather than adding a parallel
column — see the 3A-2 migration.

## 9. The complete approved predefined location list

**Food** (12): One Food World, DC Cafe, Food Court, Street Bites, Darling
SPL Mess, PR Caterers, PR Caterers Special Mess, Liv Cafeteria, Quick
Bites, Canteen, Lassi House, Amul, **Dominoes Pizza** (added this pass, not
part of the originally approved 11 — owner-supplied coordinate, added
directly on instruction).

**Shops** (7, plus 1 ambiguous — see §11): Balaji Store, All Maart, Enzo,
Master Xerox Printouts, Ganga Xerox, **Main Chotta Dhobi Branch**, **Main
Dry Cleaning Shop** (both added this pass, not part of the originally
approved list — owner-supplied coordinates, added directly on
instruction) — Ganga Xerox exists twice in the real data at two genuinely
different locations (~1.9km apart, near Main Gate and near P Block); both
are seeded as separate points rather than arbitrarily picking one — see
§11.

**Accommodation** — see the correction in §9a below. Not a flat 24-point
list: Men's Hostel and Ladies Hostel blocks sharing a letter are separate,
physically distinct `campus_points` rows.

### 9a. Accommodation model — CORRECTED (supersedes the original §9 entry above)

**The original decision — one `campus_points` row per letter (A–T), shared
between "Men's Hostel K" and "Ladies Hostel K" as a display-only
prefix — was wrong and is now obsolete.** Men's Hostel A and Ladies
Hostel A are real, physically distinct buildings with different
coordinates, confirmed directly by the project owner. Treating them as
one row would have routed a delivery to the wrong physical building.

**Corrected data model**: `campus_points` gained a `wing` column
(`'mens' | 'ladies' | null`) — real geographic identity, not a label
concern. `wing` is `null` for every non-accommodation point, and for any
accommodation point whose wing hasn't been confirmed (never guessed).
Each wing gets its own row, own key, own coordinate, own
`nearest_path_node_id` snapping — nothing is shared between them, **except**
where the project owner has explicitly confirmed two wing rows are the same
physical coordinate (e.g. Ladies Hostel A/B below, adjacent buildings with
one shared entrance) — in that case both rows intentionally carry the same
lat/lng, by instruction, not by omission.

**Confirmed so far**: Men's Hostel A (`hostel-mens-a`, seeded), Ladies
Hostel A (`hostel-ladies-a`, seeded), Ladies Hostel B (`hostel-ladies-b`,
seeded, same coordinate as Ladies Hostel A per owner confirmation), Ladies
Hostel G/H/J (`hostel-ladies-g`/`-h`/`-j`, seeded, all three share one
entrance per owner confirmation), Ladies Hostel D/E/F (`hostel-ladies-d`/
`-e`/`-f`, seeded, all three share one entrance per owner confirmation),
Ladies Hostel C (`hostel-ladies-c`, seeded, own coordinate), Ladies Hostel
S (`hostel-ladies-s`, seeded, own coordinate). These are new rows,
independent of the pre-existing `hostel-block-f`/`-g`/`-h`/
`-j`/`-n`/`-p`/`-s`/`-t` rows (wing = null, unconfirmed generic
Annex/Other blocks — untouched; `hostel-block-b`, `hostel-block-d`, and
`hostel-block-e` were later retired — `-b`/`-e` merged into the
confirmed men's-wing row (§9a below), `-d` deleted outright as an
ambiguous duplicate once both Men's Hostel D and Ladies Hostel D existed
separately).

**Ladies-wing inventory now complete**: the owner confirmed A, B, C, D, E,
F, G, H, J, and S are the *only* ladies-wing blocks — no other letter has
a separate ladies building. Per explicit instruction, the never-resolved
generic placeholder rows for the remaining letters (`hostel-block-a`,
`-c`, `-i`, `-k`, `-l`, `-m`, `-o`, `-q`, `-r` — all had `lat`/`lng` null
and `active = false` since the original seed, never a real coordinate)
were deleted rather than left as permanent dead rows — see the
`delete_empty_hostel_blocks` migration. `hostel-block-f`/
`-g`/`-h`/`-j`/`-n`/`-p`/`-s`/`-t` are untouched: they carry real
coordinates from OSM and remain in the "Annex/Other" bucket since their
gender association still isn't confirmed.

**Men's-wing inventory**: Men's Hostel A, B, C, D, D Annexe
(`hostel-mens-d-annexe` — a real, separate annexe building, not a lettered
block), E, F, G, H, J, K, L, M, N, P, Q, R, and T are all seeded with
owner-supplied coordinates (`hostel-mens-a` through `hostel-mens-t`, plus
`hostel-mens-d-annexe`). **No unfilled `hostel-mens-*` placeholder rows
exist to delete** (rows were only ever created once a coordinate was
supplied, so there was nothing pending to clean up here, unlike the
ladies-wing pass).

Men's Hostel H and J (`hostel-mens-h`, `hostel-mens-j`) were added after
the fact, sourced from Google Maps, superseding the earlier note that
neither had a separate men's building — that earlier "that's all there
is" answer turned out to be incomplete for H and J specifically, not
wrong about the rest of the batch. The original generic
`hostel-block-h`/`-j` rows (unconfirmed-gender "Annex/Other") stay as-is,
untouched, still carrying their own different coordinates.

**I and O don't exist as blocks at all** — the owner confirmed this
directly, closing out the last open question in the accommodation
inventory. Their generic placeholders were already deleted in the
ladies-wing pass, and no further row is created for either. The
accommodation catalog is now fully resolved.

**What this means for the 11 already-seeded single-letter blocks** (B, D,
E, F, G, H, J, N, P, S, T, sourced from OSM's single-building tags before
this correction): their `wing` stays `null` — **not reassigned to a guess**,
because their OSM source data never carried a gender tag and there's no
reliable way to know which wing each belongs to (or whether the other
wing for that same letter even exists as a separate building at all).
They remain selectable, but only under the picker's "Annex / Other"
bucket, until confirmed one at a time — same coordinate-verification
discipline as everything else in this document.

**Picker structure** (§8's "Accommodation" category, sub-grouped):
- **Men's Hostel** — points where `wing = 'mens'`
- **Ladies Hostel** — points where `wing = 'ladies'`
- **Annex / Other** — points where `wing = null`: MGB, the three Annexes
  (genuinely wingless — never lettered blocks), *and* the 11
  not-yet-wing-confirmed single-letter blocks above (temporarily, until
  resolved)

**Routing/authorization implication**: none. `compute_walking_route()` and
`compute_walking_route_custom()` already operate on `campus_points.id`,
which is already point-specific — a Men's Hostel A row and a Ladies
Hostel A row were always going to route independently once both exist as
separate rows. This correction only fixes *which row* a selection
resolves to, not the routing architecture itself.

**Academic** (8): SJT, TT / Technology Tower, MB, PRP (canonical display
name; see §13 for the OSM-name alias), GDN, SMV, CDMM Building, TT
Annexe. MB, GDN, SJT, TT, and SMV now have owner-supplied coordinates
(this and the prior pass). **Academic Block was removed from the catalog
entirely** — it never had a coordinate and the owner explicitly instructed
its placeholder row deleted rather than left pending — see §11.

**Sports & Recreation** (12): TT Basketball Court, TT Volleyball Court,
Anna Audi Tennis Court, Anna Audi Basketball Court (×2, kept as two
distinct courts per the approval), Anna Audi Volleyball Court, MH
Basketball Court, MH Tennis Courts, MH Volleyball Court, MH Swimming Pool,
VIT Women's Indoor Sports Room, Outdoor Stadium, Running Track.

**Medical & Health** (3): Health Centre, Saravana Medical, Saravana
Pharmacy.

**Landmarks** (7): Main Gate (owner-supplied coordinate, this pass — see
§12 correction note), Anna Auditorium, VIT Lake, Kalpana Chawla Ground,
Chillout Plaza, Tiruvallur Statue, EV Periyar Library (canonical display
name; see §13 for the "Central Library" alias).

## 10. Which locations have verified coordinates

Every location in §9 **except** the ones listed in §11 has a real,
sourced coordinate — either supplied directly by you (§12) or read from
OpenStreetMap's public tag data during this session's inventory pass.
(Balaji Store's original OSM-cross-checked coordinate was later replaced
with a Google Maps value you supplied directly — see §12's correction
note; the OSM value is no longer current.)

## 11. Which locations are still missing coordinates

Nothing invented for these — each is a real gap in the source data, not an
extraction miss (a targeted follow-up Overpass query specifically for
these names returned no match):

Nothing remains in this list. Academic Block — the last entry here — was
never resolved (no `name` tag anywhere in the extract, no owner-supplied
coordinate offered) and was explicitly removed from the catalog entirely
per the owner's instruction, rather than left pending indefinitely — see
the `delete_academic_block` migration.

(Main Gate, MB, GDN, SJT, SMV, and TT/Technology Tower were in this list
too — all now have owner-supplied coordinates, see §12.)

Per your instruction, these are asked for **one at a time**, not batched.

## 12. Exact coordinates you have personally supplied

These are authoritative and must not be replaced by any OSM-derived value:

| Point | Latitude | Longitude | Source |
|---|---|---|---|
| One Food World | 12.9729273 | 79.1576229 | You — corrects a previously seeded value (12.9762191, 79.1617006, ~570m away) you confirmed was wrong (seeded this pass) |
| Balaji Store | 12.9711421 | 79.1601536 | You, source: Google Maps — corrects a previously seeded value (12.9714358, 79.1596932, ~60m away, identified as Balaji Bookstore, VIT) you confirmed should be replaced (seeded this pass) |
| DC Cafe | 12.9700697 | 79.1588878 | You, source: Google Maps, verified real-world listing "DC Bakery" — corrects a previously seeded value (12.9703649, 79.1596033, ~84m away); no alias added, name stays "DC Cafe" only, per §13 (seeded this pass) |
| Men's Hostel A | 12.9728603 | 79.1571792 | You (already seeded) |
| Ladies Hostel A | 12.9683973 | 79.1581136 | You (seeded this pass) |
| Ladies Hostel B | 12.9683973 | 79.1581136 | You — same coordinate as Ladies Hostel A, confirmed: the two buildings are adjacent and share one entrance (seeded this pass) |
| Ladies Hostel G | 12.9684713 | 79.1587524 | You — same coordinate as Ladies Hostel H/J, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel H | 12.9684713 | 79.1587524 | You — same coordinate as Ladies Hostel G/J, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel J | 12.9684713 | 79.1587524 | You — same coordinate as Ladies Hostel G/H, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel D | 12.9708674 | 79.16112 | You — same coordinate as Ladies Hostel E/F, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel E | 12.9708674 | 79.16112 | You — same coordinate as Ladies Hostel D/F, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel F | 12.9708674 | 79.16112 | You — same coordinate as Ladies Hostel D/E, confirmed: shared entrance (seeded this pass) |
| Ladies Hostel C | 12.9711241 | 79.1611683 | You (seeded this pass) |
| Ladies Hostel S | 12.9739448 | 79.1652998 | You — confirmed as the last ladies-wing block; no letter beyond A-J/S has a separate ladies building (seeded this pass) |
| Men's Hostel B | 12.974364414540558 | 79.15749180953112 | You — corrects the earlier 12.9739175/79.1576353 value; also confirmed as the same building as the generic "Block B" row, which was retired |
| Men's Hostel C | 12.972822793023177 | 79.15827720317452 | You — negligible precision refinement (~1.6m) of the earlier value |
| Men's Hostel D | 12.972758792367959 | 79.15884490389365 | You — negligible precision refinement (~3m) of the earlier value |
| Men's Hostel D Annexe | 12.973192 | 79.159176 | You (seeded this pass) |
| Men's Hostel E | 12.9729553 | 79.1597987 | You, source: Google Maps — corrects the earlier 12.972649/79.159782 value; also confirmed as the same building as the generic "Block E" row, which was retired (seeded this pass) |
| Men's Hostel F | 12.9738601 | 79.1578854 | You (seeded this pass) |
| Men's Hostel G | 12.9735188 | 79.1595773 | You (seeded this pass) |
| Men's Hostel K | 12.9726417074389 | 79.16139490160037 | You — refines the earlier 12.9727675/79.1614224 value, ~14m away, same building |
| Men's Hostel L | 12.972825818964964 | 79.16267065377032 | You — refines the earlier 12.9727623/79.1623961 value, ~30m away, same building |
| Men's Hostel M | 12.9730334 | 79.1631864 | You (seeded this pass) |
| Men's Hostel R | 12.9732649 | 79.1633352 | You, source: Google Maps — refines the earlier 12.9731082/79.1633293 value, ~18m away, same building (not renamed) (seeded this pass) |
| Men's Hostel Q | 12.9737816 | 79.1639856 | You, source: Google Maps — refines the earlier 12.973882/79.163952 value, ~13m away, same building (not renamed) (seeded this pass) |
| Men's Hostel P | 12.974014 | 79.164187 | You (seeded this pass) |
| Men's Hostel N | 12.975144 | 79.1639319 | You, source: Google Maps — refines the earlier 12.975105/79.163701 value, ~25m away, same building (not renamed) (seeded this pass) |
| Men's Hostel H | 12.9721565 | 79.1575627 | You, source: Google Maps — supersedes the earlier "no separate men's building for H" note (seeded this pass) |
| Men's Hostel J | 12.972298 | 79.158091 | You, source: Google Maps — supersedes the earlier "no separate men's building for J" note (seeded this pass) |
| Main Gate | 12.9712123 | 79.1577843 | You — corrects a previously seeded value (12.968811, 79.155957) that you confirmed was wrong (seeded this pass) |
| MB (MGR Building) | 12.9689001 | 79.1558853 | You (seeded this pass) |
| GDN | 12.9692627 | 79.154946 | You (seeded this pass) |
| SMV | 12.9691918 | 79.1568926 | You (seeded this pass) |
| SJT | 12.971368 | 79.163495 | You (seeded this pass) |
| TT (Technology Tower, core building) | 12.971015101308465 | 79.1594605952797 | You — corrects a previously seeded value (12.9700902, 79.1579793, ~190m away, given earlier this session) you confirmed was wrong (seeded this pass) |
| All Maart | 12.97011422129549 | 79.15425672878584 | You — refines a previously OSM-sourced value (12.9700963, 79.154349, ~10m away), same building (seeded this pass) |
| Enzo | 12.972550416858027 | 79.15890608493197 | You — refines a previously OSM-sourced value (12.9724576, 79.1588679, ~11m away), same building (seeded this pass) |
| Main Chotta Dhobi Branch | 12.972243686504571 | 79.15873232118946 | You — new Shops-category point, added directly on your instruction (seeded this pass) |
| Main Dry Cleaning Shop | 12.972315976217141 | 79.15959017493336 | You — new Shops-category point, added directly on your instruction (seeded this pass) |
| EV Periyar Library | 12.9692504 | 79.1570887 | You — corrects a previously seeded value (12.9693226, 79.1568558) you confirmed was wrong (seeded this pass) |
| PRP | 12.9719322 | 79.1660942 | You — corrects a previously seeded value (12.9714153, 79.1662525) you confirmed was wrong (seeded this pass) |
| Dominoes Pizza | 12.9711677 | 79.1633116 | You — new Food-category point, added directly on your instruction (seeded this pass) |
| Men's Hostel T | 12.9741135 | 79.1660211 | You (seeded this pass) |

## 13. Alias / compatibility rules

- **Campus Store → Balaji Store**: the `campus_points` row's stable key
  remains `campus-store` (do not rename the key — orders already
  reference it by id, and `delivery_point_id` on historical orders must
  keep resolving). Its **display label** is updated to "Balaji Store".
  App-facing name changes; database key does not.
- **DC Cafe**: app-facing name stays **DC Cafe**, unconditionally. The OSM
  listing "DC Bakery" is *not* used to rename it — noted as a possible
  same-place candidate in the inventory, never auto-applied.
- **EV Periyar Library ↔ Central Library**: canonical display label is
  "EV Periyar Library" (the real, verifiable name); "Central Library"
  is preserved as a recognized alias so any historical reference or
  future search for that term still resolves to the same point.
- **Perl Research Park ↔ PRP**: canonical display label is "PRP" (matches
  the project's existing usage and the campus's own common abbreviation);
  "Perl Research Park" (the literal OSM spelling) and "Pearl Research
  Park" (the likely intended spelling) are both preserved as aliases.

Aliases are a display/lookup concern only — each real-world place is still
exactly **one** `campus_points` row with one stable `key`.

## 14. Custom pin behavior

A requester picking a delivery destination can choose **either** a
catalog point **or** "Drop a pin":

1. Map renders, centered on campus.
2. User taps/clicks a location; a marker appears there.
3. User can drag the marker before confirming (re-picking is just another
   tap/drag, not a separate mode).
4. User enters a short free-text note.
5. On submit, the exact tapped coordinate + note are stored on the order
   (§16) — never resolved against `campus_points`, never given a
   `delivery_point_id`.

## 15. Custom pin note/comment behavior

The note is **for human understanding only** — shown to the deliverer
alongside the map/route so they can find the exact spot ("outside TT
Tower, near the north entrance"). It is never used as a routing input,
never geocoded, never parsed for a location. Routing always uses the
tapped coordinate itself (§18), regardless of what the note says.

## 16. How predefined points and custom pins differ

| | Predefined catalog point | Custom pin |
|---|---|---|
| Storage | `orders.delivery_point_id` (FK to `campus_points`) | `orders.custom_delivery_lat`/`lng` (raw coordinate) + `orders.custom_delivery_note` (text) |
| Identity | Stable, reusable, shared across orders | One-off, specific to this order only |
| Routing | `compute_walking_route(pickup_id, delivery_point_id)` | `compute_walking_route_custom(pickup_id, lat, lng)` |
| Graph snapping | Pre-computed once at seed time (`nearest_path_node_id`) | Computed live, per request |
| Visibility rules | Same as any campus reference data | Same as `delivery_location` today (§7) — not a new authorization shape |

`delivery_point_id` and the custom columns are mutually exclusive per
order: a predefined-point order has `delivery_point_id` set and the custom
columns null; a custom-pin order has the custom columns set and
`delivery_point_id` null. Both cases still populate `delivery_location`
(the existing jsonb column) for backward-compatible display — see §20.

## 17. Routing behavior for predefined destinations

Unchanged from the prior 3A pass: `pickup_point_id` + `delivery_point_id`
→ `compute_walking_route()` → real pgRouting distance/geometry/ETA, or a
haversine fallback if either point isn't graph-connected yet.

## 18. Routing behavior for custom pins

`pickup_point_id` + custom `(lat, lng)` → `compute_walking_route_custom()`:
finds the nearest `campus_path_nodes` row to the tapped coordinate live
(not pre-snapped, since a custom pin's location is unknown until the
moment it's placed), routes from the pickup's pre-snapped node to that
node via the same `pgr_dijkstra` call, and adds the tapped point's own
last-mile distance to its nearest node — same last-mile-plus-graph pattern
already used for predefined points. If no path node is found within a
sane radius, or the pickup point itself isn't graph-connected, falls back
to straight-line haversine between the pickup's coordinate and the custom
pin — never fails, never fabricates a routed-looking line that isn't real.

## 19. Missing-coordinate behavior

Unchanged principle from the original 3A proposal, now applied to the
expanded catalog too: a `campus_points` row with no coordinate is seeded
with `lat`/`lng` null and `active = false` (enforced by the existing
`campus_points_active_requires_coords` check constraint) — it exists in
the schema (so nothing needs to be re-added later) but is invisible to
`campus_points_select_active` and unusable for routing until a real
coordinate lands. The picker UI only ever lists active points.

## 20. Backwards compatibility requirements

- `orders.restaurant_name` and `orders.delivery_location` (jsonb) are
  unchanged and continue to be populated for every order, predefined or
  custom-pin — nothing that reads them today breaks.
- `orders.pickup_point_id` / `delivery_point_id`: unchanged shape, simply
  null for custom-pin orders instead of always-set.
- New columns (`custom_delivery_lat`, `custom_delivery_lng`,
  `custom_delivery_note`) are additive and nullable — existing rows are
  entirely unaffected, no backfill.
- No historical order is rewritten by any migration in this pass.

## 21. RLS/security requirements

- `campus_points`: unchanged policy (`select using (active)`, no write
  policy for any role).
- New/renamed `kind` values: no RLS implication — the widened check
  constraint only changes which strings are valid, not who can read them.
- Custom pin columns: no new policy needed or added (§7) — they inherit
  `orders`'s existing `orders_select_participant` /
  `orders_select_pending_feed`, which is the deliberate choice, not a gap.
- `compute_walking_route_custom`: same posture as `compute_walking_route`
  — invoker rights (not `SECURITY DEFINER`, since every table it reads is
  already readable by the caller via its own RLS), `revoke ... from anon`
  applied explicitly (not just `from public`), `grant execute ... to
  authenticated` only.

## 22. Testing requirements

Added/updated this pass (see the 3A-2 implementation report for the exact
file list): category filtering in the points hook, campus point lookup by
key/category, predefined-destination selection end-to-end in
`PostRequest`, custom-pin selection + note entry, route calculation for
both predefined and custom-pin paths, distance/ETA display, missing-
coordinate (inactive point) behavior, and security tests confirming
unrelated users cannot read another order's custom destination beyond
what `delivery_location` already exposed, that custom pin data is never
treated as live GPS, and that existing (pre-3A-2) orders continue to
render correctly.

## 23. Explicitly deferred (not in 3A)

- Final tip/reward formula (distance is shown; the reward stays
  user-selected).
- 3B — nearby discovery / smart matching.
- Notifications.
- Ratings / trust.
- Social graph.
- Payments.
- Personalization.

None of these are touched by this document or by 3A-2's implementation.
