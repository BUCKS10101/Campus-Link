# 3E — Social Graph / Friends Spec (architecture proposal, pending approval)

**Status: ARCHITECTURE ONLY. No table alteration, RPC, trigger, RLS
policy, hook, or UI component has been implemented yet.** Source of
truth for 3E once approved.

## 1. Audit of the existing `friendships` table (live, staging-verified)

Read directly from the baseline schema and confirmed live against
staging with real privilege/policy queries (not assumed):

```
id            uuid pk, default gen_random_uuid()
requester_id  uuid, references profiles(id)   -- nullable, no ON DELETE rule
addressee_id  uuid, references profiles(id)   -- nullable, no ON DELETE rule
status        varchar, default 'pending'      -- NO CHECK constraint at all
created_at    timestamptz, default now()
```

**Live-confirmed state on staging:**
- RLS is enabled with exactly **one** policy: `friendships_select_own`
  (`auth.uid() = requester_id`) — addressee-side rows are invisible to
  their own recipient. Unusable for a real bidirectional flow as-is.
- **No INSERT/UPDATE/DELETE policy exists at all.** Live privilege check
  confirms `anon` and `authenticated` both still hold full table-level
  `GRANT ALL` (INSERT/UPDATE/DELETE/SELECT/TRUNCATE/TRIGGER/REFERENCES) —
  the same platform-default-grant pattern found and fixed in 3C and
  designed around correctly in 3D. Here it doesn't matter *yet*: Postgres
  RLS requires an explicit policy for INSERT/UPDATE/DELETE to be allowed
  at all once RLS is enabled — with zero write policies present, every
  write is already blocked regardless of the table-level grant. This
  table is currently unwritable by any client, which is safe but also
  means **zero product behavior exists behind it.**
- **No unique constraint of any kind.** Duplicate identical rows are
  possible, `A→B` and `B→A` can coexist simultaneously, and a user could
  (if writes were ever opened up naively) insert unlimited duplicate
  pending requests.
- **No self-friendship guard.** `requester_id = addressee_id` is not
  rejected by anything in the schema.
- **No `status` vocabulary enforcement.** Any string is currently a
  legal value.
- Only one index beyond the primary key: `friendships_requester_id_idx`.
  No index on `addressee_id` — a real "requests I've received" query
  would be a sequential scan.
- **Zero rows on staging.** Confirmed via `select count(*) from
  friendships` — this table has never been written to, anywhere, ever.
  There is no historical data shape to preserve or migrate.
- `src/lib/database-types.ts`'s `Friendship` type doesn't even model
  `status` as a real union — it's `status: string`, confirming the
  frontend never assumed a lifecycle either.

**Conclusion: the table is reusable, not replaceable.** `id` /
`requester_id` / `addressee_id` / `created_at` are exactly right and
untouched. What's missing is entirely additive: a `status` CHECK, a
self-friendship CHECK, a canonical-pair uniqueness constraint, an
`addressee_id` index, and a correct participant-scoped SELECT policy.
Nothing here requires dropping or rewriting the table — this migration
is in the same spirit as 3D's ratings migration: new constraints/indexes/
policies over an otherwise-correct shape, not a redesign.

## 2. Canonical relationship model

**One row per unordered pair, ever.** `requester_id`/`addressee_id`
still record who *initiated* the relationship (a real, harmless
historical fact — same reasoning 3D used for keeping `reviewer_id`
un-swapped after a rating), but a second relationship between the same
two people — in either direction, at any status — must be impossible.

Enforced with a functional unique index, not application logic alone
(the same "the constraint is the real dedup mechanism" discipline from
3C/3D):

```sql
create unique index friendships_canonical_pair_idx
  on friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
```

This single index makes `A→B` + `B→A` coexisting, or two identical
`A→B` rows, both structurally impossible — not just discouraged by a
check-before-insert that could race.

Self-friendship: `check (requester_id <> addressee_id)`.

## 3. Final lifecycle states — two, not three

**`pending` and `accepted` only.** Decline and cancel are **not**
persisted statuses — both simply delete the pending row:

- **Decline** (addressee acts on an incoming request) → delete.
- **Cancel** (requester withdraws their own outgoing request) → delete.

They're the same underlying operation (remove a still-pending row),
just gated on a different caller role. Modeling either as a persisted
terminal status (`declined`/`cancelled`) would mean deciding whether a
new request can ever be sent again over a stale row (it would need
special-casing against the canonical-pair unique index), for a record
nobody has asked to keep — no UI in this spec shows "declined
history," and neither product surface benefits from remembering it.
Deleting is the simplest defensible rule (same posture 3D took on
rating edit/delete): **do not add a third state without a demonstrated
need.**

`status check (status in ('pending', 'accepted'))`.

Full lifecycle:
```
(no row) --send_friend_request--> pending --accept_friend_request--> accepted --remove_friend--> (no row)
                                     |
                                     +--decline_friend_request (addressee)--> (no row)
                                     +--cancel_friend_request (requester)---> (no row)
```

## 4. Write mechanism — SECURITY DEFINER RPCs only, no client write policy at all

Mirrors 3D's `submit_rating()` shape exactly: every write goes through a
function that derives the caller's identity from `auth.uid()` and
validates against the trusted row itself, never trusting a
client-supplied role/id/status.

```sql
create or replace function public.send_friend_request(p_addressee_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  if p_addressee_id = auth.uid() then
    raise exception 'You cannot send yourself a friend request';
  end if;

  insert into friendships (requester_id, addressee_id, status)
  values (auth.uid(), p_addressee_id, 'pending')
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'A relationship with this student already exists';
end;
$$;

create or replace function public.accept_friend_request(p_friendship_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row friendships%rowtype;
begin
  select * into v_row from friendships where id = p_friendship_id;
  if not found or v_row.addressee_id <> auth.uid() then
    raise exception 'Request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This request is no longer pending';
  end if;
  update friendships set status = 'accepted' where id = p_friendship_id;
end;
$$;

create or replace function public.decline_friend_request(p_friendship_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row friendships%rowtype;
begin
  select * into v_row from friendships where id = p_friendship_id;
  if not found or v_row.addressee_id <> auth.uid() then
    raise exception 'Request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This request is no longer pending';
  end if;
  delete from friendships where id = p_friendship_id;
end;
$$;

create or replace function public.cancel_friend_request(p_friendship_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row friendships%rowtype;
begin
  select * into v_row from friendships where id = p_friendship_id;
  if not found or v_row.requester_id <> auth.uid() then
    raise exception 'Request not found';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This request is no longer pending';
  end if;
  delete from friendships where id = p_friendship_id;
end;
$$;

create or replace function public.remove_friend(p_friendship_id uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_row friendships%rowtype;
begin
  select * into v_row from friendships where id = p_friendship_id;
  if not found or auth.uid() not in (v_row.requester_id, v_row.addressee_id) then
    raise exception 'Friendship not found';
  end if;
  if v_row.status <> 'accepted' then
    raise exception 'You are not friends with this person';
  end if;
  delete from friendships where id = p_friendship_id;
end;
$$;
```

Each: `revoke all ... from public, anon; grant execute ... to authenticated;`
— unlike 3C's triggers (never client-callable), these **are** meant to
be called directly by the client, same asymmetry already documented in
3D §5/§6.

## 5. RLS strategy

```sql
drop policy if exists "friendships_select_own" on friendships;
create policy "friendships_select_participant" on friendships
  for select
  using (auth.uid() = requester_id or auth.uid() = addressee_id);

revoke all on friendships from anon, authenticated;
grant select on friendships to authenticated;
-- No insert/update/delete grant to any client role, ever - the only
-- write path is the five RPCs above.
```

Both participants can now see a friendship row (pending-outgoing,
pending-incoming, and accepted), covering every list the UI needs with
plain `SELECT`s — no RPC needed for reads, only for state changes.

## 6. Search / discovery + privacy model

**Resolving the task's 10 open questions:**

1. **Exact name search** — yes (trivially covered by partial match).
2. **Partial name search** — yes, this is the actual mechanism.
3. **Email searchable/displayed** — **no.** Email is already
   participant/self-only in `profiles` RLS; a directory search must not
   leak it.
4. **Hostel/block visible in search** — **no.** The task's own
   recommended direction explicitly excludes "exact hostel location."
   Once two people are friends, nothing new is exposed beyond what
   already exists for order counterparts — no new hostel-visibility
   surface is added by 3E.
5. **Mutual-friends count** — **no**, deferred. Extra query, no
   demonstrated need, no UI in this spec calls for it.
6. **Friend request notifications** — **yes**, both received and
   accepted (see §7).
7. **Blocking** — **no**, deferred (see §12).
8. **Unfriend notification** — **no, deliberately.** Real products
   (Instagram, Facebook) intentionally never notify on unfriend — it
   manufactures social conflict for zero product benefit. Documented as
   a considered "no," not an oversight.
9. **Friend list visibility** — **participant-only.** No user gets
   another user's full friend graph; `friendships_select_participant`
   only ever returns rows you're actually in.
10. **3B ranking influence** — **not now**, documented relationship
    only (§10) — matches the explicit instruction not to touch 3B this
    milestone.

**Search mechanism**: one SECURITY DEFINER RPC, `search_profiles(p_query
text)`, bypasses the profile-visibility gap the same way 3D's
`get_profile_reputation()` did (a stranger's profile isn't visible via
normal `profiles` RLS at all), but returns **only** the fields cleared
above — never a raw `profiles.*` row:

```sql
create or replace function public.search_profiles(p_query text)
returns table(
  id uuid, name text, avg_rating numeric, rating_count integer,
  relationship text
)
language sql security definer set search_path = public, pg_temp stable
as $$
  select
    p.id, p.name,
    (select round(avg(score), 1) from ratings where reviewee_id = p.id),
    (select count(*)::int from ratings where reviewee_id = p.id),
    coalesce((
      select case
        when f.status = 'accepted' then 'friends'
        when f.status = 'pending' and f.requester_id = auth.uid() then 'pending_outgoing'
        when f.status = 'pending' and f.addressee_id = auth.uid() then 'pending_incoming'
      end
      from friendships f
      where (f.requester_id = auth.uid() and f.addressee_id = p.id)
         or (f.addressee_id = auth.uid() and f.requester_id = p.id)
    ), 'none')
  from profiles p
  where p.id <> auth.uid()
    and p.name ilike '%' || trim(p_query) || '%'
  order by p.name
  limit 10;
$$;

revoke all on function public.search_profiles(text) from public, anon;
grant execute on function public.search_profiles(text) to authenticated;
```

One call returns everything "Find students" needs — name, safe
aggregate reputation, and the caller's actual relationship to each
result — so the UI never needs a second per-row query to decide whether
to show "Add," "Pending," or "Friends." `limit 10` plus a client-side
debounce (see §8) keeps this from becoming per-keystroke traffic. No
`pg_trgm`/extension added — at this project's realistic scale (one
campus), a plain `ilike` scan under a 10-row limit is cheap; a trigram
index is a future optimization if the user base ever grows enough to
need it, not a $0-cost requirement today.

Individual rating comments are never touched by this function — it
reuses the same two aggregate numbers 3D already exposes, nothing more.

## 7. Notification integration — extends the existing 3C table, doesn't duplicate it

3C's `notifications.order_id` is currently `NOT NULL` — friend-request
events have no order at all. 3C's own spec anticipated this exact case
("If a future milestone (e.g. 3E friend requests) needs a non-order-
scoped type, that's the moment to relax this column — not now"). This
is that moment. **Additive/relaxing only**, no existing order-related
trigger, policy, or column is touched:

```sql
alter table notifications alter column order_id drop not null;
alter table notifications add column friendship_id uuid references friendships(id) on delete cascade;

alter table notifications drop constraint notifications_type_check;
alter table notifications add constraint notifications_type_check
  check (type in (
    'order_accepted', 'order_picked_up', 'order_out_for_delivery',
    'order_delivered', 'new_chat_message',
    'friend_request_received', 'friend_request_accepted'
  ));

alter table notifications add constraint notifications_exactly_one_subject check (
  (order_id is not null and friendship_id is null) or
  (order_id is null and friendship_id is not null)
);

-- The existing unique(recipient_id, order_id, type) can't dedup
-- friendship-scoped rows (order_id is null there, and NULL <> NULL for
-- uniqueness purposes) - a second, partial constraint covers that scope
-- without touching the first:
create unique index notifications_recipient_friendship_type_key
  on notifications (recipient_id, friendship_id, type)
  where friendship_id is not null;
```

Two new triggers on `friendships`, same shape as 3C's `orders`/
`chat_messages` triggers (SECURITY DEFINER, never client-callable):

- `notify_friend_request()` — `AFTER INSERT`, notifies `addressee_id`
  with `friend_request_received`.
- `notify_friend_accepted()` — `AFTER UPDATE ... WHEN (old.status =
  'pending' and new.status = 'accepted')`, notifies `requester_id`
  (the original sender) with `friend_request_accepted` — **not** the
  addressee, who just performed that action themselves (same
  self-action exclusion rule 3C established for order-lifecycle
  notifications).

No notification on decline/cancel/remove — matches §6's "no unfriend
notification" reasoning, and a decline notification would be exactly
the awkward, conflict-generating signal being deliberately avoided.

**Display text**: extend the existing "derive, don't store" helper
(`notificationContent.ts`) with two more cases — `friend_request_received`
→ `"{name} sent you a friend request."`, `friend_request_accepted` →
`"{name} accepted your friend request."` — requiring the notification
list to join the *other* participant's name, the same way lifecycle
notifications already join `orders.restaurant_name`.

**Click-through**: both new types navigate to `/friends` (the Requests
section for a received request, the Friends list for an acceptance) —
never a random page, per the task's explicit requirement.

## 8. Profile / Friends UI architecture

A dedicated route is justified: three real sub-views (list, requests,
search) with enough surface area (a search box + results + accept/
decline actions) that folding this into Profile's existing single-page
"Manage" rows would turn Profile into exactly the dashboard both this
and 3D's instructions forbid.

- **Profile** gets one more row, styled identically to the existing
  "Activity" row (`View activity →`): `Friends` / `12` / `View
  friends →`, linking to `/friends`. Same pattern already established,
  no new visual language.
- **`/friends`** (new route, reached via Profile's link and notification
  click-through — **not** added to the fixed 4-slot `MobileNav` or
  `DesktopNav`, same reasoning as 3D's rating dialog not needing a nav
  slot): three stacked sections, editorial/ruled like the rest of the
  app:
  - **Friends** — accepted rows (`status='accepted'`), name + reuse of
    3D's blended reputation figure if already surfaced elsewhere, a
    "Remove" action per row.
  - **Requests** — split into "Received" (addressee = me, pending;
    Accept/Decline) and "Sent" (requester = me, pending; Cancel) —
    or a single list with per-row context text if that reads cleaner;
    final layout call left to implementation, same latitude 3D left for
    its rating dialog's exact shape.
  - **Find students** — a search input (debounced, §6/§9) + results,
    each row showing name + aggregate reputation + one contextual
    action button driven by `relationship` (`Add` / `Pending` /
    `Requested` / already-`Friends`, no button).
- All three sections read from data already fetched by one
  `useFriends()`-style hook (one `select * from friendships where
  auth.uid() in (requester_id, addressee_id)` query, split into three
  buckets client-side) — not three separate round trips.

## 9. Migration requirements (staging only, `wemjskpbulebxgyhyhmk`)

1. `friendships`: add the two CHECK constraints (§2, §3), the canonical-
   pair unique index (§2), the `addressee_id` index, drop the old
   `friendships_select_own` policy and create
   `friendships_select_participant` (§5), `revoke all` / `grant select`
   to `authenticated` only.
2. The five friendship RPCs (§4) + explicit revoke/grant execute.
3. `notifications` table extension (§7): nullable `order_id`, new
   nullable `friendship_id`, widened type CHECK, the "exactly one
   subject" CHECK, the new partial unique index.
4. Two new triggers on `friendships` (§7) + explicit revoke execute
   from every client role (never callable directly, same as 3C's
   triggers).
5. `search_profiles()` RPC (§6) + explicit revoke/grant execute.
6. Live-verify immediately after applying (same discipline as 3C/3D):
   confirm `authenticated`/`anon` cannot INSERT/UPDATE/DELETE
   `friendships` directly, confirm all five RPCs are `authenticated`-
   executable and not `anon`-executable, confirm the two new triggers
   are not directly executable by any client role, confirm a duplicate/
   reverse-duplicate/self-request insert attempt fails structurally.

## 10. 3B ranking integration — deferred, documented only

Not implemented in 3E. Documented relationship for 3F:

```
friendship (accepted) → trust/social signal → future opportunity
ranking (3F, not before) → e.g. a friend's request could be weighted
alongside 3D's reputation and 3B's distance/reward signals
```

The old "Friends" filter mentioned in earlier phases stays retired until
3F actually designs a real matching formula that uses this graph — not
reintroduced reflexively just because the underlying table now works.

## 11. Indexes / query strategy

- `friendships_canonical_pair_idx` (functional unique, §2) — also
  serves as the lookup path for "does a relationship already exist
  between these two ids," used implicitly by the unique-violation catch
  in `send_friend_request`.
- New `friendships_addressee_id_idx` — the existing table only indexed
  `requester_id`; "requests I've received" (`addressee_id = auth.uid()`)
  would otherwise be a sequential scan.
- `search_profiles`: one query, `limit 10`, no pagination in v1 (matches
  "sensible result limit," not a general directory).
- Friends/Requests page: one query total (§8), split into three buckets
  in memory, not three round trips.
- No realtime subscription for friendships in v1 — a new pending
  request already surfaces via the existing notification bell/realtime
  channel (3C); the `/friends` page itself just re-fetches on mount/
  action, same as Profile's reputation figure.

## 12. Blocking / safety — deferred, documented

No moderation, reporting, or block mechanism exists anywhere in this
app today (same finding 3D made for rating comments). Building a
"block" feature now would be exactly the "half-built system because it
sounds important" the task warns against — with no abuse-recovery
process to plug it into, it would just be a lonely status flag no other
part of the product reacts to. **Deferred, not rejected** — revisit
once real usage surfaces an actual need (unwanted repeated requests,
harassment reports), at which point it deserves its own reviewed
design, not a bolt-on here.

## 13. Test strategy

**Authorization:**
- self-request (`p_addressee_id = auth.uid()`) rejected.
- an outsider (neither requester nor addressee) cannot accept/decline/
  cancel/remove a friendship they're not party to.
- the requester cannot call `accept_friend_request` on their own
  outgoing request (only the addressee can).
- the addressee cannot call `cancel_friend_request` (only the requester
  can); the requester cannot call `decline_friend_request` (only the
  addressee can).
- neither participant can remove a friendship that isn't `accepted` yet.

**Integrity:**
- duplicate request (`A→B` twice) rejected via the canonical unique
  index.
- reverse duplicate (`A→B` then `B→A`) rejected the same way.
- a non-`pending`/`accepted` status value is rejected by the CHECK
  constraint.
- accepting/declining/cancelling a request that's already been resolved
  (not `pending` anymore) is rejected.

**Lifecycle:** send → accept; send → decline (row gone); send → cancel
(row gone); accepted → remove (row gone); a fresh `send_friend_request`
after a decline/cancel/remove succeeds (proving the delete-not-status
model actually allows re-requesting).

**Search:** results never include email/phone/hostel fields (assert the
RPC's return shape has none); a made-up substring returns zero rows, not
an error; the caller never appears in their own results; `relationship`
reflects the real state (`none`/`pending_outgoing`/`pending_incoming`/
`friends`) for a few seeded relationships.

**Notifications:** a `send_friend_request` produces exactly one
`friend_request_received` row for the addressee; accepting produces
exactly one `friend_request_accepted` row for the original requester,
never for the accepter; declining/cancelling/removing produce none;
re-sending after a decline doesn't double up thanks to the partial
unique index.

**UX (component-level, mocked hooks — same depth as existing
`RatingDialog.test.tsx`):** pending-outgoing shows "Cancel," not
"Accept"; pending-incoming shows "Accept/Decline"; accepted shows
"Remove"; empty friends list shows a plain empty state, not an
invented illustration; search input debounces (doesn't fire on every
keystroke in a rapid sequence); a failed RPC call surfaces a friendly
error, not a silent no-op.

## 14. Accessibility

- Search input has a real associated label (not a bare placeholder).
- Accept/Decline/Cancel/Remove are real, labeled buttons (`aria-label`
  including the other person's name where the visible text alone would
  be ambiguous, e.g. multiple "Remove" buttons in one list).
- Relationship state in search results is conveyed through visible text
  ("Pending," "Friends"), never an icon/color alone — same rule 3C/3D
  already established for unread/read state.
- Toast confirmations (send/accept/decline/cancel/remove) reuse the
  existing `useToast` mechanism, no new pattern.

## 15. Mobile behavior

- `/friends` is a normal routed page (not a nav-bar-anchored Sheet/
  Popover like 3C's notification panel) — it's substantial enough
  (three sections) to deserve its own scrollable page, reached the same
  way any other non-nav-bar destination is reached in this app.
  Reachable from Profile's "View friends" link and from a notification
  click-through, exactly like `/my-orders` today.
- Search results and friend rows reuse existing list-row patterns
  (`MyOrders`' past-order rows, `NotificationsList`'s rows) rather than
  inventing a new card component.
- Touch targets on Accept/Decline/Remove meet the same 44px floor
  already established by `IconButton`/`Button`.

## 16. Performance

- `search_profiles`: one RPC call per debounced search action (not per
  keystroke), `limit 10`.
- `/friends` page: one `friendships` query on mount, split into three
  buckets client-side — no N+1, no per-row relationship query.
- No new realtime subscription; the existing 3C notification channel
  already covers "something happened while I wasn't looking."
- Nothing added to Home's render path — 3B ranking is untouched, per
  the explicit instruction.

## 17. Explicitly deferred

- **Blocking** (§12).
- **Mutual-friends count** (§6, item 5).
- **Unfriend notifications** (§6, item 8 — a considered "no," not a gap).
- **3B ranking integration** (§10).
- **Declined-request history** — never persisted at all (§3); nothing
  to defer, it was designed out entirely.
- **Trigram/full-text search indexing** — plain `ilike` is sufficient at
  current scale (§6); revisit only if the user base genuinely grows
  enough to need it.
- **Friend-of-friend discovery, mutual connections, suggested friends**
  — not requested, not built; the task's own scope is send/accept/
  decline/cancel/remove + search, nothing more.

## 18. Open product decisions for you

All ten items the task asked to resolve are resolved above with
reasoning (§6) rather than left open — but two are genuinely worth a
second look before implementation, since they're the ones with the
least precedent elsewhere in this codebase:

1. **Search field scope** — plain substring match on `profiles.name`
   only (no email, no hostel). Confirm this is enough, or whether a
   phone-number lookup (for a friend you already know in person) should
   also be supported — I'd recommend **not** adding it, since phone
   numbers are otherwise private data in this app (only visible to
   order counterparts today) and a phone-based directory lookup would
   be a meaningfully bigger privacy surface than a name search.
2. **"Requests" page layout** — one combined list with per-row context
   text, or two visually separate "Received"/"Sent" groups. Both are
   equally simple to build; happy to default to two separate groups
   (clearer at a glance) unless you'd prefer the combined version.
