# 3H — Preferences + Personalization Spec (architecture proposal, pending approval)

**Status: ARCHITECTURE ONLY. No table, RPC, trigger, RLS policy, hook, or
UI component has been implemented yet.** Branch:
`feat/phase-3-preferences-personalization`. Everything below was traced
directly from the current repo (`src/lib/ranking.ts`, `src/pages/Settings.tsx`,
`src/pages/Profile.tsx`, `src/pages/Home.tsx`, `src/hooks/useCampusPoints.ts`,
`src/hooks/useFriends.ts`, `src/lib/database-types.ts`, and every
`profiles`/`campus_points`/`notifications`/`friendships` migration) —
nothing here is assumed.

**Revision note**: the base architecture (§1–§17) was approved as-is. This
revision adds one capability on top of it — optional live device location
for discovery (§3.1–§3.5) — and updates §4, §10, §11, §12/§13, §14, and
§16 to integrate it. Nothing else changed; every other section stands as
previously approved. Superseded language (the original radius definition,
which measured an errand's own trip length rather than proximity to the
viewer) is called out explicitly where it's replaced, not silently
dropped.

## 1. Current-state audit

**What exists today, verified by reading the code, not inferred:**

- `profiles` has `hostel_block`/`hostel_type` columns, but **they are
  never written anywhere in the app** — no signup field, no edit-profile
  field (`Profile.tsx`'s `EditProfileDialog` only edits `name`/`phone`).
  `Home.tsx`'s own comment confirms this explicitly: *"nothing in the app
  knows where the viewing student actually is (`profiles.hostel_block` is
  never written anywhere...)"*. There is no live or stored user-location
  signal of any kind — this rules out anything implying "near me" or GPS
  proximity.
- `Settings.tsx` (built in an earlier, unrelated pass) contains **Account**
  (password change, sign-out), **Privacy** (one informational, non-toggle
  paragraph about live-location behavior), **Appearance** (dark mode), and
  **About**. None of this is 3H — there is no discovery, notification-type,
  or friend-visibility control anywhere in it today.
- `src/lib/ranking.ts` (3B/3F) is pure and deterministic: `getTrustTier`
  (routed/fallback/unresolved from `distance_km`/`distance_source`),
  `rewardDensity`, `rankQuickErrands`, `rankHighReward`, `rankFeatured`,
  and `rankRecommended` (3F's strict lexicographic hierarchy: eligibility →
  tier → reward → reputation → friendship → recency). `filterByLocation`/
  `LocationFilter` (3B's manual "Where" filter) already supports filtering
  the board by a single `pickupPointId`/`deliveryPointId` pair, applied
  upstream of every tab's ranking — this is the existing extension point
  3H should reuse, not duplicate.
- `campus_points` (3A) is the only real, structured location model in the
  app: categorized (`food`/`shop`/`accommodation`/`academic`/`sports`/
  `medical`/`landmark`), with `wing` (`mens`/`ladies`/`null`) correctly
  keeping e.g. Men's Hostel A and Ladies Hostel A as physically distinct
  rows. `useCampusPoints()` already fetches the full active catalog once
  and exposes `byKey`/`byCategory`/`byWing` helpers, reused verbatim by
  `PostRequest.tsx`'s pickup/destination pickers.
- Notifications (3C, extended by 3E/3G) has exactly **eight** types today:
  `order_accepted`, `order_picked_up`, `order_out_for_delivery`,
  `order_delivered`, `order_cancelled`, `new_chat_message`,
  `friend_request_received`, `friend_request_accepted`. Every one is
  inserted **unconditionally** by a `SECURITY DEFINER` trigger function
  (`notify_order_status_change`, `notify_new_chat_message`,
  `notify_friend_request`, `notify_friend_accepted`) — there is no
  existing preference check anywhere, so a "notification preference"
  toggle does not yet correspond to any real backend lever. Building one
  means changing these trigger functions, not just the client.
- Friends (3E): `search_profiles()` (`SECURITY DEFINER`) returns any
  profile whose name matches, for any authenticated caller, with no
  visibility opt-out. There is no `discoverable`/privacy flag anywhere on
  `profiles`. Existing friendships are protected separately (
  `profiles_select_friendship_counterparty`), unrelated to search.
- No `user_preferences`-shaped table exists. No preference of any kind is
  currently persisted per-user beyond `profiles`' identity fields and the
  theme choice (which lives in `localStorage` via `next-themes`, not the
  database, and is out of scope here).

## 2. User preference model

One new table, `user_preferences` (one row per user, 1:1 with `profiles`),
for the six single-valued preferences (five from the base architecture,
plus `use_live_location` from this revision — see §3), plus one new join
table, `user_preferred_points` (many rows per user), for preferred campus
areas — see §12 for the exact schema and the tradeoff reasoning for two
tables instead of one, and for why this is a new table rather than more
columns on `profiles`.

A user with no row in either table sees **exactly today's behavior** —
every default equals the current, unconfigurable behavior (discoverable,
friendships used in ranking, both notification categories on, no radius
limit, no preferred areas). This is what makes the feature purely additive
and safe for every existing account with zero migration/backfill.

## 3. Discovery-radius definition

**Revised** (superseded by the live-location addition below): the original
proposal defined `discovery_radius_km` as a cap on an errand's own
walking-route trip length (`orders.distance_km`) — "hide errands whose own
route is longer than N km," unrelated to where the viewer currently is.
The live-location addition makes that framing actively confusing to keep
alongside a genuine proximity-to-viewer radius, since the brief is explicit
that trip-length and proximity "are different signals" that must not be
mixed. **`discovery_radius_km` now means proximity to the viewer, and only
that** — see §3.1. The original trip-length idea is dropped, not kept as a
second hidden meaning of the same number.

3A/3B's existing routed/fallback trip-length distance display (the
`~0.4 km` caption already shown on every `OrderCard`, `formatOrderDistance`)
is completely unaffected by this — it keeps showing the errand's own route
length exactly as it does today, independent of and never blended with the
new proximity filter below.

## 3.1. Live device location for discovery (Mode A)

**Precise definition**: when the user has explicitly turned on "Use my
current location," `discovery_radius_km` means the maximum **straight-line
(haversine) distance** between the device's current coordinates (from
`navigator.geolocation`) and the order's pickup point — never a routed/
walking distance (that would require sending the live coordinate through
3A's routing RPC, i.e. persisting or transmitting it server-side, which
§3.3 rules out entirely). This is a real, if cruder, proximity measure —
never described as "walking distance," always as straight-line/"as the
crow flies" proximity in the UI copy.

- **Anchor point**: the order's `pickup_point_id` (resolved against the
  already-fetched `useCampusPoints()` list, the same source `PostRequest`/
  `MyOrders` already use — no new fetch). Pickup, not delivery, because
  discovery is from a prospective *deliverer's* point of view: "can I
  realistically go get this." An order whose pickup point doesn't resolve
  to a real coordinate (legacy/unresolved) is never hidden by this filter
  — same "never hide what can't be honestly measured" rule already used
  for the routed-distance case in the pre-revision §3, just applied to a
  different measurement.
- **Radius values**: three presets — 500 m / 1 km / 2 km — not a free
  numeric input (§11), stored as `0.5`/`1`/`2` in the same
  `discovery_radius_km` column.
- **One-shot, not continuous** (see §3.4/§14): a single
  `navigator.geolocation.getCurrentPosition()` call, never `watchPosition`,
  and never the delivery-tracking infrastructure (`usePublishDeliveryLocation`/
  `useDeliveryLocation`, 3A) — that mechanism is Realtime-Broadcast-based,
  built for an active delivery between two specific people, and has
  nothing in common with a one-off "where am I right now" read for
  filtering a public board. A new, separate, much smaller hook
  (`useDiscoveryLocation`, distinct name, distinct file) is proposed
  instead of extending or branching that one.

## 3.2. Preferred-campus-area fallback (Mode B)

Exactly the mechanism in §4, unchanged, used whenever Mode A isn't active:
permission denied, unavailable, unsupported, timed out, or the user simply
hasn't turned "Use my current location" on. Mode B is a pure **membership**
filter (pickup or delivery point is in the user's saved preferred set) —
it has no radius/distance component of its own. `discovery_radius_km` is
simply not consulted while Mode B is active; the two modes are read as an
either/or switch (§3.5), not as two simultaneously-applied numeric filters.

## 3.3. Privacy model

- The device coordinate is **never sent to Supabase, in any form** — no
  new column, no RPC parameter, no log line carries it. The entire
  straight-line-distance computation happens client-side, in the same
  process that already holds both the coordinate (in React state) and the
  campus points' lat/lng (`useCampusPoints()`, already fetched for other
  reasons). There is nothing for the database to expose, because the
  database never receives it — satisfies "never exposed through the
  database" by construction, not by an access-control decision.
- **Only the on/off preference is persisted** — `user_preferences.use_live_location
  boolean default false` (§3.5/§12) — never the coordinate itself, never a
  history of coordinates. Toggling it back off, or simply closing the tab,
  discards whatever position was in memory; nothing survives to the next
  session except the boolean choice.
- Never visible to any other user, never attached to any notification, and
  never touches the existing live-*delivery*-location feature's data path
  (that one is real-time, participant-scoped, and already documented
  separately in 3A — this is a different, unrelated capability that
  happens to also use `navigator.geolocation`).
- No background/continuous tracking of any kind — the browser is asked
  for a position exactly when discovery needs to (re-)evaluate it, never
  on a timer, never while the tab isn't the one asking.

## 3.4. Permission lifecycle and failure states

All handled the same way: **fall back to Mode B, don't block the page.**

| State | Detection | Behavior |
|---|---|---|
| Not yet asked | initial state, `use_live_location` just turned on | Request immediately; show a brief "Getting your location…" state |
| Granted | `getCurrentPosition` success callback | Apply the Mode A proximity filter using the returned coordinate |
| Denied | error callback, `error.code === PERMISSION_DENIED` (1) | Fall back to Mode B; show one clear inline line ("Location access is off — showing your preferred areas instead") with a link to Settings; do not re-prompt automatically |
| Position unavailable | `error.code === POSITION_UNAVAILABLE` (2) | Fall back to Mode B; same inline message, generic wording ("Couldn't get your location") |
| Timeout | `error.code === TIMEOUT` (3), an explicit `timeout` option is set on the request | Fall back to Mode B; message invites retry ("Try again") rather than implying permission was denied |
| Unsupported browser | `'geolocation' in navigator` is false, checked before ever calling it | Mode A is not offered as a choice at all in Settings for that session (not shown as a broken toggle) |
| Low accuracy | `position.coords.accuracy` (meters) very large relative to the chosen radius (e.g. > 1000 m against a 500 m radius) | Still applied (rejecting outright would make indoor/building-interior fixes — common on a campus — always fail); a small caveat line is shown ("Your location may be imprecise right now"), not blocked |
| User revokes permission later, in the browser's own UI | Not detectable mid-session with a one-shot call (there is no active `watchPosition` subscription to be revoked out from under) — this scenario simply doesn't arise; the *next* time discovery needs a position, the browser reports Denied again through the normal path above | No special handling needed — a direct consequence of not watching continuously |

The whole of Home continues to render and function in every failure case
— only the discovery-mode indicator and which filter is active change;
nothing about the board, the other tabs, or any other page depends on
location succeeding.

## 3.5. Mode selection

One persisted boolean decides intent: `user_preferences.use_live_location`.
Effective mode at render time:

```
if use_live_location AND a fresh Mode A position was obtained this session
  → Mode A (proximity, discovery_radius_km as a straight-line cutoff)
else
  → Mode B (preferred-area membership filter, if any areas are saved;
    otherwise no discovery-location filter is applied at all)
```

A user can have preferred areas saved *and* `use_live_location = true` at
the same time — the saved areas simply sit dormant while Mode A is
successfully active, and take back over automatically the moment Mode A
fails or is turned off, with no separate action needed. This is why §17's
original "explicitly deferred" list needs no addition here: the two modes
were always meant to compose as a fallback chain, not as mutually
exclusive stored states.

## 4. Preferred-campus-area semantics (Discovery Mode B)

This is Mode B from §3.2/§3.5 — the fallback discovery mechanism whenever
live location isn't active. It no longer needs its own "My areas" toggle
as a separate concept from the location mode switch (see §11) — it's
simply what's applied whenever Mode A isn't. A user may select **zero or
more** `campus_points` rows (any kind —
accommodation, food, academic, etc., not just their own hostel) as
"preferred areas." The picker reuses `useCampusPoints()`'s existing
`byCategory`/`byWing` helpers verbatim — the same category/wing structure
`PostRequest.tsx` already uses, so Men's Hostel A and Ladies Hostel A stay
exactly as distinct as they already are everywhere else in the app. No
free-text location is ever accepted.

**What it affects**: whenever Mode B is the active discovery mode (§3.5)
and at least one area is saved, it restricts every visible tab to orders
whose `pickup_point_id` **or** `delivery_point_id` is in the user's
preferred set. This is a pure **filter**, applied at exactly the same
pipeline stage as the existing manual Where filter (upstream of any tab's
ranking), not a reorder/annotation. It is never silent: Home always shows
which discovery mode is currently active and why (§3.4's table doubles as
the copy for this), with one visible control to turn discovery-location
filtering off entirely regardless of mode. An order whose own pickup/
delivery point isn't in `campus_points` at all (legacy/custom-pin/
unresolved order) never matches this filter — same "null never matches a
specific filter" rule `matchesLocationFilter` already encodes.

**Removing a preference**: full replace-on-save (delete then insert the
current selection) — no separate "remove" endpoint needed for a small,
infrequently-edited multi-select.

**Deleted/deactivated campus points**: `useCampusPoints()` already only
returns `active` rows; a stored `campus_point_id` that no longer resolves
to an active point is simply not present in the picker's checked state or
the applied filter set — silently ignored, never an error, matching how
the rest of the app already treats point IDs it can't resolve.

## 5. Quiet-hours model — **not built in 3H V1, and here is why**

The brief asks to investigate whether quiet hours are genuinely useful
with the current notification architecture. Having read it end to end
(§1): **all eight existing notification types are either an active
order's real-time status or an active social event** — there is no
"discovery"/marketing-style notification type in the product at all that
would be safe to silently delay or drop overnight. Suppressing
`order_picked_up`/`order_out_for_delivery`/`order_cancelled` during a
user's stated quiet hours would mean a requester genuinely misses knowing
their delivery is imminent, or a deliverer misses knowing their order was
pulled out from under them — real product harm, not a convenience.
Delaying (queueing for post-quiet-hours delivery) would require a
background job/scheduler that does not exist and would be new
infrastructure disproportionate to the benefit. Muting only some future
"attention" layer (sound/push) is moot — no such layer exists today; the
app has no push/SMS and no in-session toast for a new notification arriving,
only the passive bell badge.

**Conclusion**: there is no notification type in this product today that
quiet hours could honestly suppress or delay without doing real harm to
the core loop. Building the control anyway would be exactly the "fake
notification control with no real effect" the master plan and this brief
both explicitly warn against. **Quiet hours are deferred** (§17) until a
genuinely quiet-hours-safe notification category exists (e.g., a future
"nearby opportunity matching your preferences" discovery ping would be a
legitimate candidate — see 3B's own master-plan text — but that doesn't
exist yet either).

## 6. Notification-preference model

Of the eight types, exactly **two categories** are safe to make optional
without undermining the product's core trust signal:

| Type(s) | Toggle-able? | Why |
|---|---|---|
| `order_accepted`, `order_picked_up`, `order_out_for_delivery`, `order_delivered`, `order_cancelled` | **No** | These are the only passive way a participant learns their own active order's real status. Disabling them isn't personalization, it's self-sabotage of the core loop, with no compensating benefit — matches Settings' own existing "no dead toggles" discipline in the other direction (no toggle where the only effect is harm). |
| `new_chat_message` | **Yes** — `notify_chat_messages` | Supplementary communication on an order the user is already tracking through the (non-optional) lifecycle notifications above; muting chat pings while still knowing the order's status is a reasonable, safe preference. |
| `friend_request_received`, `friend_request_accepted` | **Yes** — one combined `notify_friend_events` | Purely social, entirely orthogonal to the delivery loop; grouped as one toggle since splitting two closely-related social events into two switches adds a control without adding a meaningfully different decision. |

Two booleans, not a generic key-value preference schema — the brief's own
rule ("don't add a complex schema if only one or two meaningful
preferences exist") applies directly here.

**How suppression becomes real** (not just hidden client-side): the three
relevant trigger functions (`notify_new_chat_message`,
`notify_friend_request`, `notify_friend_accepted`) each gain one
additional guard — before inserting, check the recipient's
`user_preferences` row for the matching boolean; if it's explicitly
`false`, return without inserting. A user with no preferences row (the
default state) is unaffected — the check only ever short-circuits on an
explicit `false`, never on absence. This is the only way the toggle is
real rather than cosmetic: the notification is never created, not merely
hidden in the client.

## 7. Friend-visibility model

Two independent, narrow booleans — not a general public-profile/privacy
system:

- **`discoverable`** (default `true`) — controls exactly one thing:
  whether `search_profiles()` returns this profile to a stranger's name
  search. Does **not** affect: existing friendships (already-connected
  users keep full access via `profiles_select_friendship_counterparty`,
  untouched), order counterparts (`profiles_select_order_counterparty`,
  untouched), or anything else. Turning it off only stops **new** people
  from finding this user by searching; it cannot un-reveal an existing
  relationship or in-progress order.
- **`use_friends_in_recommendations`** (default `true`) — viewer-side
  only: when `false`, `Home.tsx` passes an empty friend-id set into
  `rankRecommended` instead of the real fetched one, so the viewer's own
  friendships stop influencing what's boosted in *their own* Recommended
  tab. This is entirely local to the viewer's own ranking call — it does
  not touch the `friendships` table, RLS, or what any other user sees; a
  friend's order is not hidden, it just competes purely on tier + reward
  + reputation for this viewer, same as a stranger's.

Neither boolean exposes any new data to anyone — both only ever remove an
existing exposure/effect for the user who sets them.

## 8. Interaction with 3B

3B's filter pipeline (`filterByLocation` → tab-specific
`rankQuickErrands`/`rankHighReward`) is extended, not replaced, with one
more optional upstream filter stage: **exactly one** of the two discovery
filters (Mode A's proximity cutoff, or Mode B's preferred-areas
membership — never both at once, per §3.5's either/or mode selection) is
applied in the same position the manual Where filter already occupies,
before any tab's own ranking runs. It composes with Where by simple
intersection, exactly like Where already composes with the tab selection
today — a user can have a manual Where filter and an active discovery
mode at the same time; both narrow the same list. No existing 3B function's
signature or behavior changes; the new filters are new, small, pure
functions in `ranking.ts` alongside the existing ones:

```ts
export interface GeoPoint { lat: number; lng: number }

// Haversine, not routed - see §3.1 for why these must never be blended.
export const haversineDistanceKm = (a: GeoPoint, b: GeoPoint): number => { /* ... */ }

// Mode A. pickupPointById resolves order.pickup_point_id -> {lat,lng} via
// the already-fetched useCampusPoints() list. An order whose pickup point
// doesn't resolve is never excluded (matches the "never hide the
// unmeasurable" rule already used for the pre-revision radius filter).
export const filterByProximity = <T extends { pickup_point_id: string | null }>(
  orders: readonly T[],
  viewerPosition: GeoPoint,
  radiusKm: number,
  pickupPointById: ReadonlyMap<string, GeoPoint>,
): T[] => { /* ... */ }

// Mode B - unchanged from the original proposal's filterByLocation-style
// membership check, just renamed for clarity against the new Mode A filter.
export const filterByPreferredAreas = <T extends LocationFilterableOrder>(
  orders: readonly T[],
  preferredPointIds: ReadonlySet<string>,
): T[] => { /* ... */ }
```

## 9. Interaction with 3F

3F's `rankRecommended` (eligibility → tier → reward → reputation →
friendship → recency) is **not modified**. Two integration points, both
strictly upstream or orthogonal to the ranking function itself:

1. The same upstream filter stage from §8 (Mode A proximity, or Mode B
   preferred-areas — whichever is active) narrows the candidate set
   *before* `rankRecommended` ever sees it — exactly parity with how the
   Where filter already works with Recommended today.
2. `use_friends_in_recommendations = false` changes only **which
   `friendIds` set `Home.tsx` passes into `rankRecommended`** (empty vs.
   real) — the function itself, `compareTier`, `compareRewardWithinTier`,
   and `compareReputation` are byte-identical. This cannot weaken the
   tier guarantee the brief calls out: `compareTier`/`getTrustTier` never
   read from user preferences (or from GPS proximity) at all, so no
   preference — including the new live-location one — can cause a
   fallback distance to be treated as routed, or a nearby fallback route
   to be treated as more trustworthy than a farther routed one. Tier
   separation stays a pure function of `distance_km`/`distance_source`
   alone, exactly as before; proximity only ever decides in/out of the
   candidate set, never which tier an order lands in.

## 10. Home / Discovery — per-tab effect table

| Preference | All | Recommended | Quick errands | High reward | Effect type |
|---|---|---|---|---|---|
| Discovery mode A — live-location proximity | Applied | Applied | Applied | Applied | **Filters** (hides orders whose pickup is past the straight-line radius; orders with no resolvable pickup coordinate always shown; never affects trust tier) |
| Discovery mode B — preferred areas | Applied | Applied | Applied | Applied | **Filters** (membership only, no distance component) |
| `use_friends_in_recommendations` | N/A | Applied | N/A | N/A | **Reorders** (only Recommended's friendship tie-break reads it) |
| `discoverable` | N/A | N/A | N/A | N/A | Not a Home concept at all — search-only (§7) |
| `notify_chat_messages` / `notify_friend_events` | N/A | N/A | N/A | N/A | Not a Home concept — notification-creation only |
| `use_live_location` | N/A | N/A | N/A | N/A | Selects which of the two discovery filters above is active (§3.5); not itself a filter |

No preference ever **annotates** (adds a visible reason chip) in this
proposal — 3F's existing "Recommended" reason-chip logic is untouched, and
a new annotation surface isn't justified for two filters and one
ranking-input toggle.

## 11. Settings UX

Extends the existing `Settings.tsx` — no new destination, matching the
brief's own default. Two new sections, inserted between the existing
Account and Appearance sections (Privacy's existing informational
live-location paragraph stays exactly where it is; the new privacy
toggles join it in the same section rather than creating a second Privacy
heading):

**Discovery** (new section) — reflects the two-mode structure from §3:
- "Use my current location" — switch, `use_live_location`. Copy directly
  under it states plainly what this does and doesn't do: *"Uses your
  device's location to show errands near where you are right now. Your
  location is never saved or shown to anyone — it's only used in your
  browser while Home is open."* If the browser doesn't support
  geolocation at all (§3.4), this switch is not rendered rather than shown
  disabled.
- "Radius" — three preset buttons, **500 m / 1 km / 2 km** (not a free
  number input), enabled only while "Use my current location" is on;
  labeled explicitly as straight-line distance ("as-the-crow-flies from
  your current position"), never "walking distance."
- A live status line reflecting §3.4's table whenever Mode A is the
  selected intent but not currently active (e.g. *"Location access is
  off — showing errands from your preferred areas instead"*, with a link
  back to re-request/adjust), so the active mode is never ambiguous.
- "Preferred areas" — multi-select campus-point picker (reuses the
  category/wing UI pattern from `PostRequest.tsx`), showing currently
  selected areas as removable chips. Always visible and editable
  regardless of which mode is currently active, since it's the automatic
  fallback the moment Mode A isn't available.
- One "Reset discovery preferences" secondary action (clears
  `use_live_location`, `discovery_radius_km`, and every saved preferred
  area back to the defaults in §2).

**Privacy** (extends the existing section, does not replace the existing
live-location paragraph)
- "Let other students find me by name" — switch, `discoverable`.
- "Use my friendships to personalize Recommended" — switch,
  `use_friends_in_recommendations`.

**Notifications** (new section)
- "Chat messages" — switch, `notify_chat_messages`.
- "Friend requests" — switch, `notify_friend_events`.
- Explicit, deliberate **absence** of any control for the five
  order-lifecycle types (§6) — no placeholder, no disabled toggle, no
  "coming soon." Nothing implies a control exists where none should.

No quiet-hours section is added anywhere (§5).

## 12. Schema

Two new tables. **Why two, not one, and why not more columns on
`profiles`:**

- Not more `profiles` columns: `profiles` is already a broad-privilege,
  security-sensitive table (it holds phone numbers, is read by every order
  counterpart via `profiles_select_order_counterparty`, and 3D's own audit
  flagged it as a "live, unaddressed write hole" from Supabase's default
  grants). Adding five more columns there would mean re-auditing that
  table's grants/RLS yet again for fields that have nothing to do with
  identity. A dedicated table gets its own narrow, single-purpose RLS and
  grants from day one, and every future 3H-style addition is additive to
  *that* table, not another ALTER on `profiles`.
- Not one table for everything: preferred areas is inherently
  many-valued ("zero or more" — the brief explicitly says not to assume
  one hostel is enough). Cramming that into a single-row table means
  either an array column (harder to index/query per-point, awkward
  `on delete cascade` semantics when a `campus_points` row disappears) or
  a join table anyway. Splitting the single-valued preferences (six
  scalars, one row per user) from the many-valued one (a real, ordinary
  join table) is the standard relational shape for exactly this
  situation — not table-count for its own sake.
- The live-location addition needs **no new column for a coordinate** —
  per §3.3, none is ever persisted. The only new column it needs is the
  one boolean recording the user's *intent* (`use_live_location`), the
  same shape as every other 3H toggle.

```sql
create table user_preferences (
  user_id uuid primary key references profiles(id) on delete cascade,
  -- Meaning is mode-dependent - see §3. Only consulted at all while
  -- use_live_location is true and a fresh position was obtained; ignored
  -- entirely in Mode B, where preferred-area membership is the filter.
  discovery_radius_km numeric check (discovery_radius_km is null or discovery_radius_km > 0),
  use_live_location boolean not null default false,
  notify_chat_messages boolean not null default true,
  notify_friend_events boolean not null default true,
  discoverable boolean not null default true,
  use_friends_in_recommendations boolean not null default true,
  created_at timestamptz not null default now()
);
-- No updated_at: consistent with orders/ratings/friendships/notifications,
-- none of which carry one either in this schema. No coordinate/position
-- column of any kind, ever - see §3.3.

create table user_preferred_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  campus_point_id uuid not null references campus_points(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, campus_point_id)
);
```

A user with no `user_preferences` row and no `user_preferred_points` rows
is the default/legacy state — every existing account, unconditionally.

## 13. RLS

Both tables: enable RLS, `revoke all from anon, authenticated` first (the
project's own established discipline after the OTP/3C/3D privilege
incidents — never rely on Supabase's default table-level grant), then
grant back only what's needed.

```sql
alter table user_preferences enable row level security;
create policy "user_preferences_own_row"
  on user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on user_preferences from anon, authenticated;
grant select, insert, update, delete on user_preferences to authenticated;

alter table user_preferred_points enable row level security;
create policy "user_preferred_points_own_rows"
  on user_preferred_points for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on user_preferred_points from anon, authenticated;
grant select, insert, delete on user_preferred_points to authenticated;
-- no update: rows are only ever added or removed, never modified in place.
```

No `SECURITY DEFINER` anywhere for reading or writing a user's own
preferences — a plain owner-scoped RLS policy is complete and sufficient,
per the brief's own "use invoker-rights functions where sufficient." The
only functions that need modification are the three existing
`SECURITY DEFINER` notification triggers (§6) — each already runs with
elevated privilege for an unrelated, pre-existing reason (inserting into
`notifications`, which `authenticated` has no direct insert grant on);
adding one read of `user_preferences` inside an already-`SECURITY
DEFINER` function does not introduce a new privilege boundary, it uses
one that already exists. `search_profiles()` similarly already runs as
`SECURITY DEFINER`; adding a `discoverable` check to its existing `WHERE`
clause is the same story.

No new cross-user read path is introduced anywhere. A user can only ever
read/write `user_preferences`/`user_preferred_points` rows where
`user_id = auth.uid()`.

## 14. Performance

- **One batched fetch**, not one query per setting: `Promise.all([
  supabase.from('user_preferences').select('*').eq('user_id', uid).maybeSingle(),
  supabase.from('user_preferred_points').select('campus_point_id').eq('user_id', uid),
  ])`, fired once per mount (Home and Settings each do this once,
  matching the existing one-effect-per-concern pattern already used by
  `useOrders`/`useFriends`/`useRatings` — no shared cache/store exists
  anywhere else in this app either, so this isn't a regression in
  architecture).
- No realtime subscription — preferences change rarely and only affect
  the viewer's own next render; a save simply refetches (or optimistically
  updates local state), exactly like Settings' existing password-change
  flow.
- No new `MapLibre`/`CampusMap` load — the campus-point picker reuses the
  already-fetched `useCampusPoints()` list (already loaded for
  `PostRequest`, and cheap/small — a flat list, not the map component).
- No per-order query — the radius/preferred-areas filters run entirely
  client-side over the already-fetched board (`orders` state `Home.tsx`
  already holds), the same way the existing Where filter already does.
- No polling anywhere.
- **Live location**: exactly one `getCurrentPosition()` call per Home
  mount while `use_live_location` is on — never `watchPosition`, never a
  per-order or per-tab-switch request, never a background timer. A short
  `maximumAge` (e.g. 60s) is proposed so navigating between pages within
  the same session doesn't re-trigger the OS location hardware on every
  remount, while still being nowhere near "continuous tracking" — the
  browser is free to serve a position it already fetched a moment ago
  instead of re-acquiring it, which is a battery/UX optimization already
  built into the Geolocation API itself, not new tracking infrastructure.
  `enableHighAccuracy: false` — discovery only needs building-scale
  precision, not GPS-grade, which also tends to resolve faster and use
  less power. No MapLibre/CampusMap load is triggered by any of this —
  the proximity computation is plain haversine arithmetic over two lat/lng
  pairs, not a map render.

## 15. Migration plan

One additive migration, staging only
(`wemjskpbulebxgyhyhmk`, never `kjsseqlmnmiuqepfmldh`):

1. `create table user_preferences (...)` (§12).
2. `create table user_preferred_points (...)` (§12).
3. RLS + revoke/grant for both tables (§13).
4. Extend `notify_new_chat_message()`, `notify_friend_request()`,
   `notify_friend_accepted()` — each gains one `if exists (select 1 from
   user_preferences where user_id = <recipient> and <column> = false)
   then return new; end if;` guard before its existing insert. No other
   line in any of the three functions changes.
5. Extend `search_profiles()`'s `where` clause with `and coalesce((select
   discoverable from user_preferences up where up.user_id = p.id), true)`
   — legacy users (no preferences row) keep exactly today's behavior
   (discoverable), matching the "no backfill required" goal.
6. Verification block: confirm grants/RLS via `has_table_privilege`/
   `has_column_privilege` (the project's established post-migration
   check), confirm a legacy account (no preferences row) still appears in
   `search_profiles` and still receives all notification types, confirm a
   configured account's toggles actually suppress/filter as designed.

No `orders` schema change, no new `orders` column, no OTP-privilege
change, no touch to `orders_update_requester_cancel`/`orders_update_assigned_deliverer`/
the 3G cancellation trigger logic. No backfill needed — the absence of a
row **is** the correct default for every existing user.

## 16. Test plan

**Unit** (`ranking.ts`'s new pure functions — `haversineDistanceKm`,
`filterByProximity` (Mode A), `filterByPreferredAreas` (Mode B)):
- `haversineDistanceKm` matches a known reference distance between two
  real campus coordinates within a small tolerance.
- `filterByProximity` excludes an order only when its pickup point
  resolves to a coordinate **and** that coordinate is past the radius.
- `filterByProximity` never excludes an order whose pickup point doesn't
  resolve to any coordinate (parity with "never hide the unmeasurable").
- `filterByProximity`'s result is independent of `distance_source`/tier —
  a `fallback`-tier order closer to the viewer is still just "in radius,"
  never promoted to `routed` and never reordered relative to a farther
  `routed` order (proximity filters, tier ranks — the two never interact).
- `filterByPreferredAreas` matches on pickup **or** delivery point id; an
  order with both null never matches (parity with the existing
  `matchesLocationFilter` null-never-matches rule).
- exactly one of the two discovery filters is ever applied at once (mode
  selection, §3.5) — never both, never neither-when-one-should-apply.
- composes correctly with an already-active manual Where filter (both
  active at once narrows further, never conflicts).
- `use_friends_in_recommendations = false` produces the identical
  ordering as passing an empty `friendIds` set into the existing,
  unmodified `rankRecommended` — proves the integration point, not a new
  ranking behavior.

**Unit** (`useDiscoveryLocation` hook, mocked `navigator.geolocation`):
- **permission granted** — success callback fires with coordinates →
  hook state becomes `granted` with the returned lat/lng/accuracy.
- **permission denied** — error callback with `code: 1` → hook state
  becomes `denied`, never retried automatically.
- **unsupported browser** — `navigator.geolocation` absent → hook state
  becomes `unsupported` *without ever calling* `getCurrentPosition`
  (asserted via a spy that was never invoked).
- position-unavailable (`code: 2`) and timeout (`code: 3`) each map to
  their own distinct state, both falling back to Mode B the same way
  denied does.
- `enabled: false` → hook never calls the geolocation API at all (no
  request fires just because the hook is mounted).
- only ever calls `getCurrentPosition`, **never** `watchPosition` —
  asserted directly against the mock (proves the "no continuous tracking"
  requirement at the code level, not just by inspection).

**Unit** (Home integration):
- **current location within radius** — a mocked granted position + a
  seeded order whose pickup point is inside the chosen radius → order
  appears on every tab.
- **current location outside radius** — same setup, pickup point outside
  the radius → order is absent from every tab.
- **preferred-area fallback** — Mode A denied/unavailable, with preferred
  areas saved → the board narrows by membership instead, automatically,
  no user action required beyond the earlier Settings save.
- **no preferences / legacy user** — `user_preferences` fetch returns no
  row → Home behaves exactly as it does today: no radius filter, no area
  filter, full board, no error state shown.

**Component** (Settings):
- radius presets (500 m/1 km/2 km) are disabled/hidden while "Use my
  current location" is off, and only one can be selected at a time.
- "Use my current location" switch is not rendered at all when
  geolocation is unsupported (not shown as a broken/disabled control).
- preferred-areas picker respects wing distinctness (selecting Men's
  Hostel A never also selects/represents Ladies Hostel A).
- notification toggles render only for the two real categories — no
  control ever renders for the five order-lifecycle types.
- "Reset" restores every field (including `use_live_location` and
  `discovery_radius_km`) to its default and persists that.
- legacy user (no existing row) sees every default value correctly on
  first load, not a loading error.

**Database/RLS** (staging, disposable accounts):
- a user can read/update only their own `user_preferences` row — a
  cross-user read/update attempt is rejected (RLS, not just absence of
  UI).
- a user can insert/delete only their own `user_preferred_points` rows;
  cross-user attempts rejected.
- **no cross-user location exposure**: since no coordinate is ever
  persisted (§3.3), this is verified structurally — confirm the applied
  migration introduces no column capable of holding a coordinate anywhere
  in `user_preferences`/`user_preferred_points` (schema introspection), so
  there is nothing in the database any other user's query could possibly
  read.
- **no persisted raw GPS coordinates**: after a full discovery session
  using Mode A on staging, query every table this migration touches and
  confirm none contains a latitude/longitude/position value anywhere —
  the only row written is the `use_live_location` boolean itself.
- `notify_chat_messages = false` → sending a chat message to that user
  produces **zero** `new_chat_message` notification rows (checked via
  direct query, not just client behavior).
- `notify_friend_events = false` → a friend request to that user produces
  zero `friend_request_received` rows; order-lifecycle notifications are
  completely unaffected regardless of any preference value (regression
  check reusing 3G's own notification tests as the baseline).
- `discoverable = false` → that profile no longer appears in
  `search_profiles()` results for a stranger, but a pre-existing friend
  can still see them via the unrelated, unchanged
  `profiles_select_friendship_counterparty` path, and an active order
  counterpart still sees them via `profiles_select_order_counterparty`.
- a deleted/deactivated `campus_points` row referenced by an existing
  `user_preferred_points` row is silently excluded from the applied
  filter (not an error, not a broken picker state).
- legacy account (rows in neither table) behaves identically to today on
  every axis: discoverable, all notifications fire, no radius/area
  filtering applied.

**Staging E2E**:
- toggle "Use my current location" on with a mocked/injected browser
  position (headless-browser CDP override, the same technique already
  used for prior milestones' staging QA — not a real physical device
  move), confirm the Home board hides a seeded order outside the chosen
  preset radius and shows one inside it.
- deny location permission (CDP override to `denied`) with preferred
  areas saved, confirm Home falls back to the area-membership filter
  automatically and shows the fallback status line.
- add two preferred areas across different wings with Mode A off, confirm
  only matching orders remain; clear them, confirm the full board returns.
- disable friend-ranking personalization, confirm a friend's order no
  longer gets the friendship tie-break boost in Recommended for that
  viewer, while remaining fully visible and normally ranked.
- disable chat notifications for one account, send a real chat message
  from the other, confirm zero notification row created; re-enable, send
  again, confirm one row created.
- disable discoverability, confirm `search_profiles` (called as a
  different real account) no longer returns that profile, then re-enable
  and confirm it does again.
- clean up every disposable account/row created for this pass, exactly
  as every prior milestone in this project has.

## 17. Explicitly deferred (not part of 3H V1)

- **Quiet hours** entirely (§5) — no existing notification type is safe
  to suppress/delay without real product harm; revisit only if a
  genuinely quiet-hours-safe notification category (e.g., a future
  discovery/matching ping) is ever built.
- Per-notification-type granularity beyond the two real categories (§6) —
  the five order-lifecycle types stay permanently on in 3H's scope; if
  that's ever revisited it's a deliberate, separate product decision, not
  a 3H default.
- Any AI/ML-driven or inferred preference — every preference here is
  something the user explicitly sets, nothing is derived from behavior.
- A general public-profile/privacy system beyond the two narrow booleans
  in §7 — no profile-visibility levels, no "who can see my rating," etc.
- Preferred-area-driven **notifications** (e.g., "notify me when
  something's posted near my preferred area") — that's a discovery-push
  feature, not a preference, and depends on infrastructure (§5) that
  doesn't exist yet.
- Reordering (as opposed to filtering) by discovery radius or preferred
  areas — both stay pure filters in V1; turning them into a ranking input
  (e.g., "prefer but don't require") is a plausible V2 idea, not V1.
- Any change to `orders` schema, OTP privileges, or the 3G cancellation
  RLS/trigger — none of this milestone's scope touches any of them.
- Continuous location tracking of any kind (`watchPosition`, background
  updates, or a persisted position history) — a single one-shot read per
  Home mount is the entire scope; nothing in 3H ever watches, and nothing
  is ever stored (§3.1/§3.3/§14).
- Routing the live device coordinate through 3A's walking-route RPC to
  get an actual walking distance instead of straight-line — that would
  mean transmitting the coordinate to the server, which §3.3 explicitly
  rules out. Mode A stays straight-line/haversine only, by design, not as
  a stopgap.
- Reusing or extending the 3A live-*delivery*-location feature
  (`usePublishDeliveryLocation`/`useDeliveryLocation`) for discovery — a
  new, separate, much smaller hook is proposed instead (§3.1); the two
  features are unrelated beyond both touching `navigator.geolocation`.
- Any server-side or cross-user use of the discovery coordinate — it is
  never sent to Supabase at all, so there is no server-side feature to
  build on top of it in this milestone or any future one without a
  separate, explicit privacy decision.

## 18. Implementation record (as shipped)

Approved via "start"; implemented and staging-verified on
`feat/phase-3-preferences-personalization`. Nothing here changes the
approved design in §1–§17 — this section records what was actually
built, applied, and verified against it.

**Schema** — `supabase/migrations/20260831100000_user_preferences.sql`,
applied to staging (`wemjskpbulebxgyhyhmk`) only. Two tables exactly as
specified in §12 (`user_preferences`, `user_preferred_points`), one
`for all` RLS policy per table (§13), revoke-before-grant, no
coordinate-capable column anywhere. Extends `notify_new_chat_message()`,
`notify_friend_request()`, `notify_friend_accepted()`, and
`search_profiles()` with the preference guards described in §6/§7 —
byte-identical otherwise to the pre-3H originals.

**Incidental fix, fully disclosed**: while touching
`notify_friend_request()`/`notify_friend_accepted()` to add the 3H
guard, found and fixed a pre-existing 3E bug — their
`on conflict (recipient_id, friendship_id, type) do nothing` clause
could never match `notifications_recipient_friendship_type_key`, a
*partial* unique index (`where friendship_id is not null`), because
Postgres only accepts a partial index as an ON CONFLICT inference
target when the ON CONFLICT clause's own predicate matches it exactly.
Verified empirically against staging (a bare INSERT with the original
clause fails identically; adding the matching `WHERE` clause resolves
it). Since the raised exception aborts the whole enclosing
`send_friend_request()` transaction, this means friend requests have
very likely never completed successfully since 3E shipped — consistent
with staging holding exactly one `friendships` row before this fix,
almost certainly from manual QA rather than the real RPC path. Fixed
with a one-line `where friendship_id is not null` addition to both
functions' ON CONFLICT clauses, since (a) both functions were already
being modified for the 3H guard, (b) leaving it broken would make 3H's
own suppression behavior unverifiable against a working baseline, and
(c) it's a universally-triggered defect, not an edge case. Not part of
3H's scope otherwise — no other 3E behavior was touched.

**Code**: `src/lib/database-types.ts` (`UserPreferences`,
`DEFAULT_USER_PREFERENCES`, `UserPreferredPoint`), `src/lib/ranking.ts`
(`haversineDistanceKm`, `filterByProximity`, `filterByPreferredAreas` —
kept deliberately separate from 3A's routed `distance_km`, never
blended, per §3.1), `src/hooks/useDiscoveryLocation.ts` (one-shot
`getCurrentPosition`, never `watchPosition` — asserted in its own
test), `src/hooks/usePreferences.ts` (batched fetch, upsert with
explicit `{ onConflict: 'user_id' }`, full-replace preferred-points
save), `src/components/settings/DiscoverySettings.tsx`, and
integration into `src/pages/Settings.tsx` and `src/pages/Home.tsx`
exactly as specified in §11/§10 — Mode A/B selection in Home is a pure
filter, never affects 3B/3F ranking or promotes fallback to routed.

**`usePreferences.ts` correctness fix**: added `{ onConflict: 'user_id' }`
to the `.upsert()` call after a live-browser 409 during manual staging
testing (root cause was actually an orphaned test fixture with no
`profiles` row, not this call — but the explicit `onConflict` is a
correct defensive addition on a single-column primary key upsert and
was kept).

**Validation**: 463/463 tests pass (30 test files, including 8 new
`useDiscoveryLocation` tests, 8 new `usePreferences` tests, and new
Home/Settings/ranking describe blocks per §16's matrix), `tsc --noEmit`
clean, `npm run build` clean, `npm run lint` at the exact pre-existing
baseline (20 problems, 9 errors / 11 warnings, all pre-existing and
none in any 3H file).

**Staging E2E** (scripted, 12/12 checks passed): legacy-user
discoverability default; chat notification fires by default and is
suppressed by `notify_chat_messages = false` with zero rows created;
order-lifecycle notifications unaffected by that same preference;
`friend_request_received` fires by default (only after the ON CONFLICT
fix above) and is suppressed by `notify_friend_events = false`;
`discoverable = false` removes a user from `search_profiles` for a
stranger while leaving existing order/friend counterpart access
intact, and `discoverable = true` restores it; cross-user RLS rejection
on read and write of `user_preferences`; cross-user RLS rejection on
`user_preferred_points` insert.

**Real-browser verification** (headless Chrome via CDP against
staging, using a genuinely fresh test account after ruling out an
orphaned-fixture false alarm): Discovery/Privacy/Notifications sections
render in Settings; "Use my current location" toggle, radius presets,
preferred-areas picker (grouped, wing-distinct), discoverable toggle,
and chat-notification toggle all persist across a full page reload
(confirmed server-side, not just local state); Reset restores every
field to its documented default and clears every preferred-area row —
confirmed both in the UI and via direct DB queries.

**Cleanup**: every disposable staging account/row created for this
milestone (`e2e-3h-*`, `browser-3h-*` patterns) was deleted and
confirmed at zero across `notifications`, `chat_messages`,
`friendships`, `orders`, `user_preferred_points`, `user_preferences`,
and `profiles`. One known limitation carried over from every prior
milestone in this project: one orphaned `auth.users` row (from a
broken-signup test fixture, no corresponding `profiles` row) cannot be
removed without a service-role key, which this environment doesn't
have.

## 19. Post-approval audit and correction

§18 described the implementation as it stood right after "start." Real
product use surfaced functional defects in that implementation — this
section documents the audit, the actual root causes (not just the
symptoms reported), and the corrections. §1-§17 remain the approved
design; nothing here changes the architecture, only the correctness of
what was built against it.

**Root cause 1 — "enabling GPS does nothing" / "changing the radius does
nothing until I leave and come back."** Settings and Home each held
their own independent `usePreferences()` instance (two disconnected
copies of the same server row). A change made on one page was invisible
to the other until a full unmount/remount. Fixed by converting
`usePreferences` into a shared `PreferencesProvider` (`src/hooks/usePreferences.tsx`),
mounted once in `App.tsx` exactly like the existing `NotificationsProvider` -
one fetch per signed-in session, every consumer sees the same live
state instantly. Home and Settings no longer fetch preferences
themselves; the provider does, keyed on the signed-in user.

**Root cause 2 — "Home loses everything."** The mode-selection logic
(as specified in §3.5) activated Mode B (preferred-area filtering)
whenever *any* preferred areas were saved, **independent of whether
`use_live_location` was even on**. A user who had ever saved preferred
areas got their entire board silently filtered down to just those
areas, permanently, even with GPS off. This was the spec's own
mode-selection table, not an implementation slip - re-examined and
corrected here: Mode B is only ever consulted as Mode A's fallback,
while `use_live_location` is genuinely on but not currently usable
(denied/unavailable/timeout/unsupported/no radius chosen yet). With GPS
off, no discovery filter is applied at all, regardless of what's saved
in `user_preferred_points`. Fixed in `Home.tsx`'s `discoveryFilteredOrders`
(now gates on `preferences.use_live_location` first, before ever
consulting `preferredPointIds`). Verified live: saved a real preferred
area ("Amul") with GPS off, and the board still showed all 6 test
orders (see the browser-verification results below) - not filtered to
zero.

**Root cause 3 — no browser permission prompt.** Not a separate bug:
once root cause 1 was fixed, the shared preference state reaches
`useDiscoveryLocation` immediately, and `DiscoverySettings` now also
calls that same one-shot hook directly (`preferences.use_live_location`
as its `enabled` argument) so flipping the toggle requests the position
- and therefore the browser's permission prompt - immediately, on
Settings itself, rather than deferring to whenever Home next happens to
mount. Verified live: toggling the switch increments a
`getCurrentPosition` call counter injected before page load, every
time, with the exact one-shot options (`enableHighAccuracy: false,
timeout: 8000, maximumAge: 60000`) and zero `watchPosition` calls ever.

**Radius presets corrected to campus scale.** 500m/1km/2km replaced
with 50m/100m/200m/500m (`src/components/settings/DiscoverySettings.tsx`) -
1km/2km never meaningfully narrowed anything on a campus this size.
Toggling live location on for the first time (no radius chosen yet)
now injects a sensible default (200m) in the same save, rather than
silently doing nothing until a preset is separately clicked. An
unsupported browser (`!navigator.geolocation`, checked once) no longer
renders a broken toggle at all - the whole control is replaced with a
plain explanatory line, per §3.4's original table.

**Filter semantics confirmed already correct, not changed.** `filterByProximity`
(`ranking.ts`) was already pickup-only (`ProximityFilterableOrder` never
carries a delivery field) - re-verified against live data rather than
re-implemented: an order with pickup 80m away and delivery ~111km away
still shows at a 100m radius; an order with pickup 150m away and
delivery only 20m away is still hidden at a 100m radius. Delivery
distance has never participated in the live-GPS filter.

**Dynamic radius behavior confirmed correct, not changed.** The
`discoveryFilteredOrders` `useMemo` already listed `discovery_radius_km`
in its dependency array - the staleness previously observed was root
cause 1 (Settings and Home not sharing state), not a memoization bug.
With the shared provider, changing the radius on Settings and returning
to Home shows the new set immediately, with no stale entries from the
previous radius - verified at all four presets against five orders at
known distances (30/80/150/300/700m).

**Files changed in this correction pass**: `src/hooks/usePreferences.tsx`
(new, replaces `usePreferences.ts` - now a context provider), `src/App.tsx`
(mounts `PreferencesProvider`), `src/pages/Home.tsx` (mode-gating fix,
richer status line), `src/components/settings/DiscoverySettings.tsx`
(campus-scale presets, default-radius injection, own `useDiscoveryLocation`
call, unsupported-browser handling, live status line), `src/pages/Settings.tsx`
(no longer fetches preferences itself). Test files updated to match:
`usePreferences.test.tsx` (new, replaces `.test.ts` - tests the provider),
`Home.test.tsx` (new 50/100/200/500m matrix against five known-distance
pickup points, delivery-irrelevance cases, dynamic-radius-change case,
and the Mode-B-gating regression test), `Settings.test.tsx` (campus-scale
presets, default-radius injection, permission-prompt-on-toggle,
unsupported-browser hiding).

**Validation after correction**: 475/475 tests pass (12 net new since
§18's 463 - the radius matrix, delivery-irrelevance, dynamic-radius, and
Mode-B-gating regression tests), `tsc --noEmit` clean, `npm run build`
clean, `npm run lint` unchanged at the pre-existing baseline (9 errors,
now 12 warnings - the one new warning is `react-refresh/only-export-components`
on `usePreferences.tsx`, an unavoidable byproduct of exporting both a
provider component and a hook from one file, identical to the existing
warning already present on `useNotifications.tsx`).

**Real-browser staging verification** (headless Chrome via CDP,
disposable `e2e-3h-audit-*` accounts, five real campus_points inserted
at controlled distances of 30/80/150/300/700m from a fixed viewer
coordinate, five real orders with pickup at those points and delivery
deliberately far away, plus one "cross" order with pickup 150m/delivery
30m):
- Toggling "Use my current location" on Settings, with no prior
  permission grant, called `getCurrentPosition()` exactly once, with
  the correct one-shot options, zero `watchPosition` calls - confirmed
  via an instrumented counter injected before any app script ran.
- With permission granted and the position pinned via
  `Emulation.setGeolocationOverride`, the status line read "Location
  access granted — Home will show errands within your chosen radius."
- Radius matrix on Home: 100m showed the 30m+80m orders only; 500m
  showed everything except the 700m order (5 of 6, including the cross
  order, since its pickup is 150m); 50m showed only the 30m order.
- The 80m-pickup/111km-delivery order was visible at 100m; the
  150m-pickup/30m-delivery ("cross") order was hidden at 100m - delivery
  distance never rescues or excludes an order.
- Turning GPS off (with a real preferred area, "Amul", saved) showed
  all 6 orders, not zero - confirming root cause 2's fix.
- Settings persistence: toggle state and the selected 100m preset both
  read back correctly after a full page reload (`aria-checked`/
  `aria-pressed` both `"true"`).
- Reset restored the toggle to unchecked.
- Zero console errors/exceptions across the entire run.
- Direct `Network.requestWillBeSent` capture across the whole flow
  (toggle on/off, radius change, reset) found 10 real Supabase requests
  and zero containing any coordinate-shaped data (`lat`/`lng`/
  `latitude`/`longitude`, or the exact viewer coordinate) in any URL or
  request body - the privacy model holds under direct inspection, not
  just by code review.

**Cleanup**: every fixture row (5 campus_points, 6 orders, 2 profiles)
and the `user_preferences`/`user_preferred_points` rows created during
this pass were deleted and confirmed at zero. Five `auth.users` rows
across this and the original implementation pass remain - the same
known, service-role-key-dependent limitation as every prior milestone.

## 20. Second audit: real-data verification against the live staging board

§19 verified the pipeline against a fully synthetic, controlled dataset
(orders manufactured with known pickup points at exact distances) and
found/fixed three real defects. A follow-up manual test against the
*actual*, pre-existing staging board (Settings: GPS on, 50m, granted;
"Showing requests within 50m of you." shown; Home: still showed orders
whose caption read ~0.6km/0.7km/1.0km/2.0km) surfaced a fourth issue -
this section covers that investigation. **No application code changed
in this round** - the code pipeline itself is confirmed correct; the
defect was in the data.

**Root cause 4 (data, not code): most real orders had no `pickup_point_id`
at all.** Queried staging directly: 10 of 11 real pending orders had
`pickup_point_id IS NULL`. `filterByProximity` (`ranking.ts`) has always
correctly, deliberately never hidden an order whose pickup can't be
resolved to a coordinate - the same "never hide what can't be honestly
measured" rule 3A/3B already apply to routed-distance ranking, not new
or changed here. These 10 orders predate `PostRequest.tsx` ever setting
`pickup_point_id` (it does set it correctly for every order created
through the real form - confirmed in `PostRequest.tsx:264`) - they're
demo/seed-era orders from before that column was populated. Because
they were unconditionally exempt from the GPS filter, and they make up
the overwhelming majority of the visible board, the feature looked
completely broken even though it was filtering the one order that *did*
have a resolvable pickup exactly correctly. The ~0.6km/0.7km/1.0km/2.0km
captions the report described are `distance_km` (3A's routed/fallback
trip-length concept, shown in the card caption) - a different number
entirely from the GPS-to-pickup haversine distance, and irrelevant to
whether an order should pass the live-location filter.

**Fix**: `supabase/migrations/20260901100000_backfill_legacy_order_pickup_points.sql`,
applied to staging only. Backfills `pickup_point_id` for exactly the
three legacy `restaurant_name` values found (`'DC Cafe'`, `'One Food'`,
`'Campus Store'`), matched to their real, still-existing `campus_points`
rows (`dc-cafe`, `one-food`, `campus-store`) - confirmed via
`20260826160000_relabel_one_food.sql` and
`20260826130000_seed_campus_store_coordinate.sql`'s own history that
these are the exact same physical pickup locations under their
pre-rename display names, not a guess. Scoped narrowly: only touches
rows where `pickup_point_id IS NULL` and an exact `restaurant_name`
match, never an order that already has one, never any other name.

**Full 16-point data-flow trace (per the second audit request),
answered against the current code, all confirmed correct:** orders are
fetched once via `useOrders()`/`fetchOrders` (Home.tsx); `usePreferences()`
and `useDiscoveryLocation()` both come from the shared, live sources
fixed in §19 (no staleness); `filterByProximity` is called from exactly
one place (`discoveryFilteredOrders`'s `useMemo`), given the raw `orders`
array (never a stale/prior-filtered one); pickup coordinates are
resolved from `useCampusPoints()`'s already-fetched list via
`pickup_point_id`, an exact id match, not a label/text match; the
`locationFilteredOrders` -> `restOrders`/`quickErrandOrders`/
`highRewardOrders`/`recommendedOrders` chain is the only path to
anything rendered - every one of the four tabs (All/Recommended/Quick
errands/High reward) derives from `locationFilteredOrders`, never raw
`orders`; the "N errands are live" header is `locationFilteredOrders.length`,
always the true post-filter count (it read "10" in the original report
because 10 of 11 orders were, correctly given the data at the time,
unmeasurable-and-therefore-shown); delivery coordinates never enter
`filterByProximity` at all (`ProximityFilterableOrder` only carries
`pickup_point_id`) - re-confirmed empirically below, not just by code
reading.

**Real-browser re-verification against the live (now-backfilled) staging
board** (headless Chrome via CDP, one disposable `e2e-3h-realdata-*`
account, device position pinned via `Emulation.setGeolocationOverride`
to the exact real coordinate of the `campus-store` campus_point so the
11 real orders split cleanly across presets by their real, pre-existing
pickup points - `campus-store` at 0m, `dc-cafe` at a computed 181.7m,
`one-food` at a computed 338.5m from that position):

| Radius | Expected (hand-computed from real coordinates) | Observed |
|---|---|---|
| 50m | 4 (campus-store only) | 4 |
| 100m | 4 (campus-store only; dc-cafe at 182m is still outside) | 4 |
| 200m | 7 (campus-store + dc-cafe; one-food at 338m still outside) | 7 |
| 500m | 12 (all - one-food at 338m now included; a 12th order was created during this session's manual testing) | 12 |

Every value matched exactly. (An earlier pass of this same check, using
a test script that clicked through all four presets in one continuous
run with only short waits between navigations, produced incorrect
intermediate readings at 200m/500m - traced to the test harness
transitioning pages faster than intended, not an application defect;
re-run with explicit `aria-pressed` verification before each
measurement, it matched the hand-computed values exactly every time.)

**Cleanup**: the one disposable account's `profiles`/`orders`/
`user_preferences`/`user_preferred_points` rows were deleted; its
`auth.users` row remains (same known limitation).

**Validation**: no application code changed this round (data-only
migration), so the full gate was re-run to confirm no regression: 475/475
tests, `tsc --noEmit` clean, `npm run build` clean, `npm run lint`
unchanged from §19's baseline.

## 21. Third audit: proving GPS-to-pickup distance directly in the UI

A follow-up real-browser screenshot showed Home displaying orders with
large (~0.7km/~1.8km/~1.5km) captions while GPS was on at a 200m radius
- apparently contradicting the filter. Investigation (reproducing the
exact scenario against staging) found this was **not a bug**: those
captions are `distance_km` (3A's routed/fallback *delivery*-side trip
length), a different number entirely from the GPS-to-pickup distance
the radius filter actually uses - the same distinction §20 already
documented, but previously invisible in the UI, which is what made a
correct result look like a defect.

**Fix (transparency, not logic)**: `Home.tsx` now computes the real
GPS-to-pickup haversine distance for every order whenever Mode A is
active (`proximityMetersById`, using the same `pickupPointById`/
`discoveryLocation` already in scope) and shows it as its own clearly
labeled caption segment - `~Xm from you` - alongside, never replacing,
the existing `distance_km` caption. `toPostingRow` takes this as a third
argument. No filtering logic changed.

**Verified live**: reproduced the exact reported scenario (device
pinned to `one-food`'s real coordinate, 200m radius) - the same three
orders appeared with the same `~0.7 km`/`~1.8 km`/`~1.5 km` delivery
captions as the screenshot, now alongside `~0m from you`, proving the
device really was inside the 200m radius and the filter was correct.
Moving the simulated device ~2.2km away with the same 200m radius
correctly emptied the board ("Nothing moving right now"). Two new
Home.tsx tests assert the caption appears only while Mode A is active
and shows the real computed distance (477/477 total, up from 475).

**Validation**: 477/477 tests, `tsc --noEmit` clean, `npm run build`
clean, `npm run lint` unchanged.

**Cleanup**: the one disposable test account's rows were deleted (same
`auth.users`-row limitation as every round).

**Not committed or pushed.** All 3H work remains uncommitted on
`feat/phase-3-preferences-personalization`, pending explicit
checkpoint/finalize instruction.
