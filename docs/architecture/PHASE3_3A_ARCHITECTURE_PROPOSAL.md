# 3A — Location + Campus Map: Architecture Proposal

Status: **proposal only, not implemented.** Per Phase 3 Master Plan §17, this
needs review before any schema/code changes begin.

## 0. What the current schema/code actually does (grounding)

Read directly from the repo, not assumed:

- `orders.delivery_location` is `jsonb`, shaped `{ type: 'hostel'|'campus',
  label, hostelType?, block? }` — a **symbolic** location, never coordinates
  (`src/lib/orderContent.ts`).
- `orders.distance_km` is a real numeric column, but in
  `src/pages/PostRequest.tsx:66`:
  ```ts
  const randomDistance = () => Math.random() * 2 + 0.5
  const calculateSuggestedTip = (distance: number) => Math.round(distance * 20)
  ```
  — it's fabricated on the client and then shown to the requester as if real
  ("0.8 km · similar runs go for around ₹16"). This is the concrete thing 3A
  exists to fix.
- The app already operates over a **closed, small, named set of campus
  points**, hardcoded in `PostRequest.tsx`:
  - 3 restaurants/pickup points: One Food, DC Cafe, Campus Store
  - 20 hostel blocks: letters A–T
  - 8 named campus landmarks: TT Block, SJT Block, MB, PRP, GDN, Central
    Library, SMV, Academic Block
  - ≈31 points total, all VIT-Vellore-specific.
- `profiles.hostel_block` is a free-text `varchar`, not constrained to that
  same list.
- No PostGIS or geo extension is enabled anywhere in
  `supabase/migrations/`.
- A `friendships` table (requester_id/addressee_id/status) **already
  exists** in the schema and is completely unused by the UI — not this
  milestone's concern, but worth noting since it changes how much backend
  work 3E will actually need later.
- Existing security convention: sensitive reads/writes go through
  `SECURITY DEFINER` RPCs (`get_my_order_otp`, `verify_delivery_otp`), not
  raw table access; RLS policy names follow `<table>_<action>_<qualifier>`.
  3A should follow the same shape rather than inventing a new pattern.

## 1. Location data model

Add one new reference table, `campus_points`:

```sql
create table campus_points (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,        -- e.g. 'hostel-block-c', 'one-food'
  label text not null,             -- e.g. 'Block C', 'One Food'
  kind text not null check (kind in ('restaurant', 'hostel_block', 'campus_landmark')),
  lat double precision not null,
  lng double precision not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
```

This is reference/seed data, not user data — it replaces the hardcoded
`RESTAURANTS`/`HOSTEL_BLOCKS`/`CAMPUS_LOCATIONS` arrays with rows that also
carry a real coordinate, so distance becomes computable. ~31 rows, seeded
once by hand-locating each point on a map (one-time work, not a runtime
dependency on anything external).

## 2. Pickup / drop-off representation

Keep `orders.restaurant_name` and `orders.delivery_location` exactly as they
are — no breaking change to existing rows or read paths that already parse
that jsonb shape.

Add one new nullable column:

```sql
alter table orders add column delivery_point_id uuid references campus_points(id);
```

Populated at order-creation time by resolving the requester's selection
against `campus_points`. Nullable and additive: existing orders keep
working with `distance_km = null` until 3A ships, and nothing currently
reading `delivery_location` needs to change. Storing the *id actually used
at creation time* (rather than re-resolving the label later) protects
historical orders from silently changing distance if a point's label or
coordinates are ever corrected.

Pickup point resolves the same way, matched against `restaurant_name` — no
new column needed there since `restaurant_name` is already the pickup
identifier.

## 3. Campus POIs

Source of truth becomes `campus_points`, not the hardcoded arrays. 3A's
actual code change in `PostRequest.tsx` is to fetch this table instead of
using the literal `RESTAURANTS`/`HOSTEL_BLOCKS`/`CAMPUS_LOCATIONS` constants
— same UI, same picker, just backed by a real table so the same value can be
joined against for distance. No new admin UI: rows are managed via a
migration, matching how the project has no admin surface today.

## 4. Distance calculation strategy

**Recommendation: haversine (straight-line) distance over the seeded
coordinates, computed server-side.** Not an external routing API.

Why this is enough for v1: the entire point universe is ~31 fixed,
known locations on one compact campus. Straight-line distance already
cleanly separates "same block," "next block over," and "other side of
campus" — which is all the current UI needs (a distance figure and a
reward suggestion, not turn-by-turn directions). It requires zero recurring
cost, zero network calls, zero external account, and is trivial to test
deterministically.

Where it's honest to flag a known limitation: a straight line can cut
through a building or a lake that the real walking path goes around, so it
will sometimes under-state actual walking distance. Proposed handling: not
solved in 3A. If real usage shows this materially misleads the suggested
reward, a v2 upgrade path exists (a small hand-curated path graph between
adjacent points, Dijkstra over it) — but that's real engineering effort I
would not spend before evidence says straight-line is actually wrong for
this campus's specific geometry.

Computed via a `SECURITY DEFINER` RPC, `compute_order_distance(pickup_id,
delivery_id)`, following the OTP RPC pattern already in use, so the number
that lands in `orders.distance_km` is server-computed and not client-editable.

## 5. Routing strategy

No routing provider. See §4 — this milestone needs a distance figure, not a
route. If a future milestone genuinely needs turn-by-turn walking directions
(not clearly a Phase 3 requirement per the roadmap), that's the point to
revisit an external API, isolated behind a small service boundary per
Master Plan §8 — not now.

## 6. Privacy model

This is the good news of using fixed POIs instead of GPS: **3A introduces no
new personal location data at all.** Every location involved is a value the
requester already explicitly picks from a dropdown today (a hostel block, a
campus landmark, a restaurant) — 3A just resolves that same pick against a
real coordinate server-side to get a real distance. No continuous tracking,
no device geolocation permission prompt, no new retention/deletion
question, nothing beyond what `delivery_location` already stores. If a
later milestone (matching, nearby discovery) ever wants live device
location, that needs its own privacy review at that time — explicitly out
of scope here.

## 7. Expected costs

$0 recurring. `campus_points` is static seed data; haversine is arithmetic,
not an API call. No new paid service, no new environment variable, no new
account to provision.

## 8. Is an external map API actually necessary?

No, for the reasons in §4/§5/§8-master-plan. The closed, ~31-point campus
graph is exactly the case the master plan's cost-discipline section
describes as sufficient without one.

## 9. How suggested reward/tip will eventually consume distance

Out of scope to build in 3A (Master Plan §4 is explicit that the formula
needs real campus geometry + usage data first, which 3A is what produces).
What 3A does set up: once `distance_km` is real, the existing "similar runs
go for around ₹X" line in `PostRequest.tsx` can show a real, honest number
instead of `randomDistance() * 20` — but the actual suggested-reward
*formula* is a 3B/3F-adjacent design decision to make later with real data
in hand, not decided speculatively here.

## 10. Migration / RLS implications

- New table `campus_points`: enable RLS, one `select` policy —
  `campus_points_select_active` — readable by any authenticated user (`using
  (active)`), matching that this is non-sensitive published campus
  reference data, same trust level as the restaurant list already hardcoded
  client-side today. No insert/update/delete policy for regular users;
  rows are seed data, edited via migration only, consistent with the
  project having no admin backend.
- `orders.delivery_point_id`: additive, nullable, `references
  campus_points(id)`. No backfill required — existing rows simply have
  `null` and keep resolving via the existing `delivery_location` label path
  in application code.
- `compute_order_distance` RPC: `SECURITY DEFINER`, follows the existing
  OTP-RPC pattern (`supabase/migrations/20260824120300_otp_verification.sql`)
  for privilege scoping — reads `campus_points`, writes nothing itself
  (distance gets set at order-creation time, same as `distance_km` is set
  today, just server-computed instead of `Math.random()`).
- No change to `orders_select_pending_feed`/`orders_select_participant` or
  any existing policy — this is additive data, not a new access pattern.
- No PostGIS extension needed — haversine is a ~5-line SQL function over
  plain `double precision` columns.

## Summary recommendation

Build a small internal `campus_points` table seeded with real coordinates
for the ~31 points the app already knows about by name, compute distance
server-side via haversine through a `SECURITY DEFINER` RPC, and stop
fabricating `distance_km` client-side. No external map/routing API, no new
recurring cost, no new privacy surface — because the product only ever
needs distance between a small fixed set of named campus locations the
requester already picks from a dropdown, not open-ended geolocation.
