# 3A — Architecture Revision: Map Rendering, Real Routing, Live Location

Status: **proposal only, not implemented.** Supersedes/extends
`PHASE3_3A_ARCHITECTURE_PROPOSAL.md` (which is not rewritten — that
document's reasoning for the `campus_points` table, RLS, and the
haversine-first cut still stands; this revision addresses the three new
requirements: a visibly rendered map, real walking-route distance instead
of straight-line, and live delivery-location tracking).

## New requirements driving this revision

- The campus map must be visibly rendered in the website.
- Order tracking must support live delivery location.
- Distance should come from an actual walking route, not haversine.
- Route distance will eventually feed the suggested reward/tip (not built
  yet — explicitly deferred per your instruction).
- Avoid unnecessary recurring API costs where possible.

## 1. Map rendering approach

**Recommendation: MapLibre GL JS, rendering a self-hosted set of map tiles
generated once from OpenStreetMap data for just the campus bounding box.**

MapLibre GL JS (BSD-3, fully open source) doesn't host tiles itself and
needs no API key of its own — it renders whatever tile source you point it
at. The campus is small (roughly a 1.5km × 1.5km area, confirmed by the
coordinate spread already sourced from OSM), so rather than depending on a
live external tile service at request time — OSM's own public tile
servers, or a paid provider like MapTiler/Stadia/Mapbox — the whole area's
tiles can be generated **once**, offline, from the same OSM extract this
session already pulled real coordinates from, and hosted from Supabase
Storage (already part of this project's stack). At runtime, nothing is
fetched from any third party at all: the client loads MapLibre GL JS (a
static library, no key) and requests tiles from our own Storage bucket.

Why not a live external tile source: OSM's own tile servers explicitly ask
that non-trivial traffic not hit them directly (their usage policy is
written for QA/light use, not production apps) — fine for the prototyping
already done this session, not appropriate to build a shipped feature on.
A paid provider (MapTiler, Stadia, Mapbox) has a genuinely free tier but
still means an account, an API key, and a per-request ceiling to watch —
an ongoing dependency for a fixed, unchanging area that a one-time export
makes unnecessary.

Why not a hand-illustrated custom map image instead: that's a legitimate,
even more on-brand option (fits Counter's editorial identity better than
a generic-looking tile map, and was explicitly worth naming per your
question 10) — but it can't support live-moving pins without a manual
calibration step (projecting real lat/lng onto illustration pixel space
via an affine transform from known reference points), and it doesn't give
users pan/zoom/orientation the way a real map does. **This is a real
product/brand call, not a purely technical one — flagging it rather than
deciding it**: the self-hosted-real-tiles approach above is my
recommendation for correctness and live-tracking support, but a
stylized/illustrated treatment of that same real tile data (custom color
palette matching forest/ivory/berry, hand-drawn-feeling building outlines)
is achievable as a styling layer on top of MapLibre without giving up
live-location support — MapLibre supports fully custom vector styles, not
just the default OSM look. I'd treat "does the map look like a generic
Google-Maps clone or does it look like CampusLink" as a real design pass
worth doing deliberately once this is built, not an afterthought.

## 2. Walking-route calculation approach

**Recommendation: pgRouting (Postgres extension, confirmed available on
Supabase) over a small campus footpath graph, computed server-side.** Not
an external routing API.

Supabase supports enabling `pgrouting` (alongside `postgis`, which it
depends on) directly from the dashboard/SQL, at no additional cost — it's
one of the ~60+ extensions already available on the platform. The same
Overpass/OSM technique already used to source point coordinates this
session can extract the campus's actual pedestrian paths/footways once,
which become a small routing graph (nodes + weighted edges, weight =
real segment distance). `compute_order_distance` (already built, currently
haversine-only) becomes a two-tier function: try `pgr_dijkstra` over the
real path graph first; if a point isn't yet snapped into the graph, fall
back to the existing haversine calculation rather than failing — same
honesty principle as today (never silently wrong, never blocks the
feature entirely while coverage is incomplete).

This is a genuinely better fit than any external routing API here, not
just a cheaper one: those APIs (Google Routes, Mapbox Directions, OSRM/
GraphHopper hosted) are built for open-ended arbitrary-address routing at
city/country scale. This product only ever routes between the same fixed
~31 named points on one compact campus — a small, static, self-contained
graph that a general-purpose routing API is genuine overkill for, and that
computing in the same Postgres instance the rest of the app already
depends on removes an entire external-service failure mode.

## 3. Live location / realtime architecture

**Recommendation: Supabase Realtime Broadcast, ephemeral (not persisted),
scoped to one order, active only during active delivery.**

This is the one genuinely new privacy surface in this revision — the
original 3A proposal explicitly deferred continuous device location,
saying it would need its own privacy review "at that time." This is that
review.

- **Ephemeral by design**: the deliverer's device publishes position
  updates to a Realtime Broadcast channel (e.g. `order-location-{orderId}`)
  — broadcast messages are pub/sub over a websocket, not written to
  Postgres. No location history table, no retention/deletion policy to
  design, because nothing is stored past the live moment.
  Nothing needed here is not already in the stack: chat already uses
  `supabase.channel(...)` for realtime (`ChatThread`/`useChat`), so this
  reuses infrastructure rather than adding a new one.
- **Scoped and authorized**: Supabase Realtime supports private channels
  with RLS-based authorization — the channel for order X should only
  admit that order's requester and assigned deliverer, mirroring the
  existing `orders_select_participant` pattern rather than inventing a new
  authorization shape.
- **Time-bounded**: only active while `status` is `picked_up` or
  `out_for_delivery`; the deliverer's client should stop calling
  `watchPosition` and unsubscribe immediately on `delivered`/`cancelled`,
  not just stop rendering it.
- **Explicit consent**: per your own privacy principles from the original
  proposal ("explicit user awareness, clear purpose, minimum necessary
  precision, appropriate retention/deletion rules") — the deliverer must
  see and accept an explicit "share your live location for this delivery"
  prompt before tracking starts, and see a persistent visible indicator
  the whole time it's active (not a silent background permission).
- **Throttled**: `watchPosition` firing on every GPS tick is wasteful and
  battery-heavy; update on a distance/time threshold (e.g. every 5–10s or
  on meaningful movement), not continuously.

## 4. Cost

- Map library (MapLibre GL JS): $0, always.
- Tiles: $0 if self-hosted from a one-time OSM export in Supabase Storage
  (recommended). A free-tier provider is also genuinely $0 in practice but
  adds an account/key/quota to monitor for no benefit given the area never
  changes.
- Routing (pgRouting): $0 — it's a Postgres extension, not a metered API.
- Live location (Realtime Broadcast): $0 marginal — already using
  Supabase Realtime for chat; broadcast messages are lightweight and
  ephemeral.

**Net new recurring cost of this entire revision: $0**, which is the
direct answer to "avoid unnecessary recurring API costs where possible."

## 5. API/key requirements

None beyond what the project already has (the Supabase anon key). No
Google Maps key, no Mapbox/MapTiler/Stadia key, no routing-provider key.

## 6. Privacy/security

- Static campus points: unchanged from the original proposal — still just
  dropdown selections, no new surface.
- Live delivery location: the one real new surface, addressed in §3
  above — ephemeral, scoped, time-bounded, consented, throttled. This is
  the part of this revision that most needs your explicit sign-off before
  implementation, more than the map/routing pieces.
- Self-hosted tiles introduce no new privacy surface (they're static
  campus geometry, not user data) but do need attribution to OpenStreetMap
  contributors per OSM's data license (ODbL) — a small, one-time
  compliance item, not an ongoing cost.

## 7. Mobile performance

- MapLibre GL JS is a WebGL vector-tile renderer — real but manageable
  bundle weight (roughly 200–300KB gzipped depending on build), must be
  **lazy-loaded** on only the screen that shows a map (order
  tracking/Activity), never on Home/PostRequest, matching the same
  discipline already applied to GSAP in Phase 2G.
- A lighter alternative (Leaflet + raster tiles, no WebGL) is worth
  naming: smaller, simpler, broader low-end-device compatibility, but
  blockier zoom/pan feel and less capable of custom vector styling for
  the on-brand treatment discussed in §1. MapLibre remains the
  recommendation given the live-tracking requirement benefits from smooth
  marker movement, but this is a reasonable fallback if real-device
  testing on low-end phones shows a problem.
- `watchPosition` on the deliverer's device: throttled per §3, both for
  battery and to avoid flooding the broadcast channel.

## 8. Is Google Maps/Routes actually necessary?

No. Same reasoning as the original proposal, reinforced: Google Maps
Platform requires a billing account (a card on file) even to use its free
credit, which is a meaningfully bigger commitment than a keyless
self-hosted approach, for a product that only ever needs one small,
unchanging, closed campus area — not global geocoding or traffic-aware
city routing.

## 9. Can OpenStreetMap + a suitable routing provider do this?

Yes — and specifically, OSM data + **self-computed** routing (pgRouting
over a one-time-extracted campus footpath graph) rather than a *hosted*
routing provider, is the better fit than any external routing API
(OSRM/GraphHopper/Mapbox/Google) for the same closed-graph reasoning as
§2. Already proven usable this session: real coordinates for 13 of this
project's points came from exactly this kind of OSM/Overpass extraction.

## 10. Is a custom campus map still practical?

Yes, and it's not mutually exclusive with §1's recommendation — see the
styling note there. A fully hand-illustrated (non-tile, single static
image) map is also still practical as a *visual style* choice, but comes
with the live-pin-calibration tradeoff described in §1. Flagging this as a
design decision for you rather than resolving it here, since it's a brand
call as much as an engineering one.

## Summary recommendation

| Concern | Choice | Recurring cost |
|---|---|---|
| Map rendering | MapLibre GL JS + self-hosted tiles from a one-time OSM export in Supabase Storage | $0 |
| Walking-route distance | pgRouting over a one-time-extracted campus footpath graph, server-side | $0 |
| Live delivery location | Supabase Realtime Broadcast, ephemeral, scoped, consented, throttled | $0 |
| External API/key needs | None beyond the existing Supabase anon key | — |

No Google Maps, no Mapbox, no external routing provider, no new recurring
cost. The one genuinely new risk surface is live device location (§3/§6),
which is the part I'd most want explicit sign-off on before writing any
code — the map/routing pieces are comparatively low-risk, reusing patterns
(OSM extraction, Postgres extensions, Realtime channels) already proven
or already present in this codebase.

Not done in this pass, per your instructions: no coordinates collected or
seeded, no tip/reward formula, no 3B work, no implementation of any of the
above — this is the revised architecture recommendation only, waiting for
your approval.
