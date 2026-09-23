# 3D — Ratings + Trust Spec (architecture proposal, pending approval)

**Status: ARCHITECTURE ONLY. No table, RPC, RLS policy, hook, or UI
component has been implemented yet.** Source of truth for 3D once
approved; will be updated if implementation decisions change.

## 0. What already exists (read before designing anything new)

- `profiles` already has `rating numeric default 0.0`, `successful_deliveries
  integer default 0`, and `balance numeric default 0.0` (baseline schema).
  **None of these are read anywhere in the current UI** — `Profile.tsx`
  shows only name/email/phone/hostel block, an edit dialog, an Activity
  link, and dark mode. They are dead columns, not currently-displayed fake
  stats (Phase 2 already removed the fake display; the columns were just
  never deleted).
- **These columns are a live, unaddressed write hole.** `profiles_update_own`
  (`using (auth.uid() = id)`) has no column scoping, and — per the exact
  platform-default-grant issue found twice already this project (OTP,
  then 3C notifications) — `profiles` almost certainly still carries
  Supabase's table-level `GRANT ALL` to `authenticated`. That means any
  signed-in user can likely run `update profiles set rating = 5, balance =
  99999 where id = auth.uid()` right now, today, with zero backend
  involvement. This has nothing to do with 3D existing yet — it's a
  pre-existing gap. **Recommendation: do not build 3D's reputation
  system on these columns at all** — see §5. Leave them alone (don't wire
  them up, don't delete them either; deleting is out of scope for a
  feature milestone and would need its own review of anything that still
  references them at the type level).
- Order participants are `orders.requester_id` / `orders.deliverer_id`.
  `deliverer_id` is set exactly once, at `accepted` (`orders_update_accept`
  sets it in the same statement that flips `pending → accepted`), and
  never cleared — so any order that ever reaches `delivered` is
  *guaranteed* to have a non-null `deliverer_id`. Ratings never need to
  handle "delivered but no deliverer."
- The real, reachable lifecycle (confirmed in 3C's own investigation,
  still true): `pending → accepted → picked_up → out_for_delivery →
  delivered`. `cancelled` is legal in the DB (`enforce_order_status_transition`)
  but has no UI trigger path anywhere — same status as 3C found it in.
  Ratings are gated on `status = 'delivered'` specifically, not on
  "terminal" generally — a `cancelled` order is never rateable.
- `MyOrders.tsx` already buckets orders into `requesterActive` /
  `delivererActive` / `past` (`TERMINAL_STATUSES = ['delivered',
  'cancelled']`). The "Earlier" section (line ~750) renders each past
  order as one compact row: restaurant name, "Asked"/"Carried" + date,
  a `StatusBadge`. This is the natural, already-existing surface for a
  "Rate this delivery" action — no new page or section needed.
- 3C's `NotificationsProvider`/trigger pattern is the direct precedent
  for "the client is never trusted to create a privileged row" — reused
  here via a `SECURITY DEFINER` RPC instead of a trigger (see §4 for why
  an RPC, not a trigger, is the right mechanism this time).
- 3B's `getTrustTier`/`TrustTier` in `ranking.ts` is unrelated — it's a
  distance-data-quality tier (routed/fallback/unresolved), not
  reputation. No naming or logic overlap to worry about.
- No moderation/report/block infrastructure exists anywhere in the app.
  This matters directly for the comment-visibility decision (§8).

## 1. Core product question this resolves

"Can I trust this student to carry my order?" — and secondarily, "was
this interaction good?" Both are answered with the same minimal
mechanism: a 1–5 score tied to one specific completed order, visible in
aggregate, gated entirely server-side on that order's real state.

## 2. Rating direction — both ways, resolved

- **Requester → deliverer: yes.** The deliverer performed the service;
  the requester experienced its quality directly (were they careful, on
  time, did they actually deliver what was picked up).
- **Deliverer → requester: yes.** The deliverer took on real effort and
  risk (time, a walk, fronting money implicitly since payments are
  deferred); they have a legitimate stake in "was this requester easy to
  work with, accurate in their request, present for the OTP handoff."
  This is a two-sided marketplace trust relationship (this codebase's own
  master plan explicitly names "deliverer rates requester where
  appropriate" as in-scope for 3D) — one-sided rating would leave
  deliverers with zero recourse to signal a bad requester experience,
  which undercuts "can I trust this student" for the *other* future
  direction of matching (a requester's own trustworthiness matters just
  as much when a deliverer decides whether to accept their post).
- **One shared mechanism, not two separate tables/flows.** Both
  directions are "the other participant on this specific completed
  order rates the participant." The RPC that creates a rating is
  identical in both directions — it derives `reviewee_id` from whichever
  role the caller does *not* hold on that order (see §4).

## 3. One rating per participant per order — no edit, no delete (v1)

- **One-time per (order, reviewer): yes**, enforced by a unique
  constraint, not just a UI convention — see §6.
- **Editing: no, not in v1.** The task explicitly warns against adding
  edit/delete "because it sounds useful" and asks for the simplest
  defensible rule. A rating is a permanent record of one specific
  delivery's outcome — like a completed exam answer, not a living
  document. Nothing in the current product surfaces a need to revise a
  rating (no dispute flow, no moderation team to arbitrate a changed
  score), and adding UPDATE means also deciding whether `updated_at`
  matters, whether the aggregate must be recomputed on edit (it already
  is live — see §7 — so this specific cost is low, but the RLS/RPC
  surface still doubles for no demonstrated need). **Deferred**, not
  rejected outright — revisit if real usage shows people submitting
  ratings by mistake often enough to matter.
- **Deletion: no, not in v1.** Same reasoning, doubly so — deletion of a
  trust signal is a more sensitive operation than editing it, and there
  is no current abuse-recovery/moderation process this would plug into.

## 4. Data model

```sql
create table ratings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  reviewer_id uuid not null references profiles(id) on delete cascade,
  reviewee_id uuid not null references profiles(id) on delete cascade,
  score smallint not null check (score between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 300),
  created_at timestamptz not null default now(),
  constraint ratings_order_reviewer_key unique (order_id, reviewer_id)
);
create index ratings_reviewee_idx on ratings (reviewee_id);
```

**Deliberately trimmed from the task's suggested shape, with reasons:**

- **Uniqueness is `unique(order_id, reviewer_id)`, not `unique(order_id,
  reviewer_id, reviewee_id)`.** For a given order, a given reviewer's
  `reviewee_id` is not an independent fact — it's fully determined by
  which of the two participants the reviewer is (see §4's RPC: the
  server derives it, the client never supplies it). Including
  `reviewee_id` in the unique key would only matter if a reviewer could
  somehow submit two different reviewee values for the same order, which
  the RPC never allows in the first place. The two-column key is
  simpler and equally correct.
- **No `updated_at`.** Only meaningful once editing exists (§3); adding
  it now would be exactly the "column for a hypothetical future" pattern
  this project's own conventions (and this task's instructions)
  explicitly avoid.
- **`comment` capped at 300 chars** — enough for a short sentence, short
  enough to stay a comment and not become an open text field needing its
  own moderation story.
- **No `reviewee_id` uniqueness/check against `orders` at the table
  level** — that validation genuinely belongs in the write path (§5),
  not as a table CHECK, because it depends on runtime order state
  (`status = 'delivered'`), which a CHECK constraint can't reference.

## 5. Write path — a SECURITY DEFINER RPC, not a trigger

3C used triggers because the *source* of a notification-worthy event
was always a state change already happening for other reasons (an
`orders` UPDATE, a `chat_messages` INSERT) — the client never directly
asks to create a notification. A rating is different: it's an
intentional, client-initiated action with real input (the score, the
comment) that needs validation *before* acceptance, and needs to return
a clear success/failure result the UI can react to. That's an RPC, not a
trigger — the same distinction the existing `verify_delivery_otp()` /
`get_my_order_otp()` functions already establish in this codebase.

```sql
create or replace function public.submit_rating(
  p_order_id uuid, p_score smallint, p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_reviewee uuid;
  v_rating_id uuid;
begin
  select * into v_order from orders where id = p_order_id;
  if not found then
    raise exception 'Order not found';
  end if;

  if auth.uid() not in (v_order.requester_id, v_order.deliverer_id) then
    raise exception 'You are not a participant on this order';
  end if;

  if v_order.status <> 'delivered' then
    raise exception 'This order has not been delivered yet';
  end if;

  v_reviewee := case when auth.uid() = v_order.requester_id
    then v_order.deliverer_id else v_order.requester_id end;

  if p_score < 1 or p_score > 5 then
    raise exception 'Score must be between 1 and 5';
  end if;

  insert into ratings (order_id, reviewer_id, reviewee_id, score, comment)
  values (p_order_id, auth.uid(), v_reviewee, p_score, nullif(trim(p_comment), ''))
  returning id into v_rating_id;

  return v_rating_id;
exception
  when unique_violation then
    raise exception 'You already rated this order';
end;
$$;

revoke all on function public.submit_rating(uuid, smallint, text) from public;
grant execute on function public.submit_rating(uuid, smallint, text) to authenticated;
```

Everything the browser could lie about — who the reviewee is, whether
the caller actually participated, whether the order is really delivered
— is resolved from the trusted `orders` row inside this function, never
taken as a parameter. This mirrors `verify_delivery_otp()`'s exact shape
(look up the trusted row, validate against `auth.uid()`, validate state,
act).

## 6. RLS + grants (learn from 3C's own mistake, this time up front)

3C's first migration attempt was silently defeated by Supabase's
platform-level default `GRANT ALL ON TABLES/FUNCTIONS TO anon,
authenticated`, discovered only after applying and checking live
privileges. 3D's migration will REVOKE ALL before granting anything,
from the start, rather than repeating that discovery cycle:

```sql
alter table ratings enable row level security;

create policy "ratings_select_participant" on ratings
  for select
  using (auth.uid() = reviewer_id or auth.uid() = reviewee_id);

revoke all on ratings from anon, authenticated;
grant select on ratings to authenticated;
-- No insert/update/delete grant to anon or authenticated at all - the
-- only write path is submit_rating() above, which runs as its owner and
-- bypasses grants for its own insert.

revoke all on function public.submit_rating(uuid, smallint, text)
  from public, anon;
grant execute on function public.submit_rating(uuid, smallint, text) to authenticated;
```

Note the asymmetry with 3C's trigger functions: `submit_rating` **must**
be granted EXECUTE to `authenticated` (the client calls it directly),
unlike 3C's `notify_*` trigger functions which were revoked from every
client role (nobody calls a trigger function directly — it only runs
implicitly). Both are still "the client can't forge a privileged write,"
just via a different mechanism.

**Verification plan mirrors 3C's**: after applying, live-check
`has_table_privilege('authenticated','ratings','INSERT')` is `false`,
`has_function_privilege('authenticated', 'submit_rating(uuid,smallint,text)',
'EXECUTE')` is `true`, and a direct `insert into ratings (...)` from an
authenticated REST session fails with a permission error before ever
touching business logic.

## 7. Aggregation — live query via RPC, no cache table, and no reuse of `profiles.rating`

**Do not reuse `profiles.rating` / `profiles.successful_deliveries`.**
Beyond the write-hole problem (§0), using them as a maintained cache
would require a second trigger (on `ratings` insert) just to keep them
in sync, plus fixing the pre-existing self-write hole on those specific
columns — two problems solved to reintroduce a caching layer this
project's own rules say to avoid ("Do NOT add cache tables unless
necessary"). At CampusLink's realistic data volume (a campus community,
not a global marketplace), `avg()`/`count()` over an indexed
`reviewee_id` column is cheap enough to compute live, every time it's
asked for — no cache, no staleness, no invalidation logic.

```sql
create or replace function public.get_profile_reputation(p_profile_id uuid)
returns table(avg_rating numeric, rating_count integer, completed_deliveries integer)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    (select round(avg(score), 1) from ratings where reviewee_id = p_profile_id),
    (select count(*)::int from ratings where reviewee_id = p_profile_id),
    (select count(*)::int from orders where deliverer_id = p_profile_id and status = 'delivered');
$$;

revoke all on function public.get_profile_reputation(uuid) from public, anon;
grant execute on function public.get_profile_reputation(uuid) to authenticated;
```

`completed_deliveries` is **not** derived from ratings at all — it's a
direct count of `orders` where this profile was the deliverer and the
order reached `delivered`. That's a real, independent, always-accurate
signal even for a profile nobody has rated yet (matches "avg_rating"/
"rating_count" being `null`/`0` for an unrated user rather than a fake
default — the UI must render "No ratings yet," never a fabricated
number or a 0-star display).

`SECURITY DEFINER` here exists only so the function can read across all
`ratings` rows regardless of the caller's own participant-scoped SELECT
policy (§6) — it never returns anything beyond the three aggregate
numbers, so there is no data-exposure risk in bypassing that policy for
this one read.

One call per Profile page load (own profile). Not queried per-order-card,
not queried on every Home render, not subscribed to realtime — a rating
changing someone's average by a few hundredths a few times a week is not
something that needs to be live-pushed.

## 8. Privacy — aggregate public (to authenticated users), row-level participant-only

- **Aggregate reputation** (`avg_rating`, `rating_count`,
  `completed_deliveries`) is visible to any authenticated user via
  `get_profile_reputation()`, regardless of whether they've ever
  interacted with that profile — this is what makes "can I trust this
  student" answerable *before* accepting their order, which is the whole
  point.
- **Individual ratings (score + comment) are participant-only** —
  visible only to the reviewer who wrote it and the reviewee it's about,
  via `ratings_select_participant` (§6). Nobody else, including someone
  who later also rates the same reviewee, sees another person's comment.
  This is the recommended direction from the task, and it's the right
  call here specifically because **there is no moderation/report/block
  system in this app at all** — a public comment feed with zero abuse
  handling is a real risk (harassment, retaliation between two students
  who already know each other), while a private one gives 100% of the
  trust value (the aggregate number) with none of that exposure.
- **Reviewer identity is never shown to anyone but the reviewee
  themselves** (and only because they can see their own received rating
  row, which includes `reviewer_id` — nothing stops them from knowing
  who rated them if they check their own past order... they already know
  who delivered/requested it). This isn't a new disclosure — the
  counterpart's identity was always visible via `profiles_select_order_counterparty`
  for the two participants on that same order.

## 9. Profile integration

Add one section to `Profile.tsx`, styled like the existing "Manage" rows
(border-b-2, `Text` primitives, same rhythm as "Profile details" /
"Activity"):

```
Rating
4.8 · based on 17 ratings

Completed deliveries
23
```

- If `rating_count === 0`: show "No ratings yet" instead of a fabricated
  0.0 or blank star row — never imply a rating exists when it doesn't.
- `completed_deliveries` shows even at 0 ("0" is a real, true fact about
  a new account — not the same as a fake default, since it reflects an
  actual `count(*)` result).
- One `get_profile_reputation(user.user.id)` call, alongside the
  existing `useAuth()`-driven profile fetch — not blocking the rest of
  Profile from rendering (same "loading skeleton only for the first
  paint" discipline `MyOrders.tsx` already uses).
- This is explicitly **not** a stats dashboard — two labeled numbers,
  same visual weight as the rest of the page, no charts, no trend lines,
  no history list on Profile itself (recent-rating history, if ever
  wanted, would belong on Activity next to the specific order, not
  invented as a new Profile section).

## 10. Activity integration

In `MyOrders.tsx`'s existing "Earlier" section (§0), for each past order
row where `order.status === 'delivered'` (never for `cancelled`):

- Fetch the viewer's own submitted ratings once per Activity load:
  `select order_id from ratings where reviewer_id = auth.uid()` — a
  single query, not one per row (avoids N+1). RLS already scopes this to
  the caller's own reviewer rows.
- If no row exists for that `order_id`, show a small "Rate this
  delivery" action inline on that row (a text-button in the same style
  as `EditProfileDialog`'s trigger, or a compact `IconButton`+label —
  final visual call left to implementation, not to be decided in this
  architecture doc beyond "reuses existing primitives, no new pattern").
- Clicking it opens a small dialog/sheet (reuse the existing `Dialog`
  primitive already used by `EditProfileDialog` in `Profile.tsx`, or a
  bottom `Sheet` on mobile matching 3C's desktop/mobile split
  convention) with 1–5 stars and an optional short comment, calling
  `submit_rating` on submit.
- On success: replace the action with a quiet confirmation ("Thanks —
  your rating was recorded.") and remove the prompt from that row for
  the rest of the session (the local "already rated" set gets the new
  `order_id` appended immediately, no refetch required).
- Never shown for `pending`/`accepted`/`picked_up`/`out_for_delivery`
  orders — only ever in the terminal "Earlier" section, and only for the
  `delivered` subset of it.

## 11. Notification integration — deliberately none, in v1

Evaluated and rejected: a dedicated "You can now rate your delivery"
notification. Reasoning:

- The requester already gets `order_delivered` (3C, existing) the moment
  their order completes — they already know it's done.
- The deliverer performs the `delivered` transition themselves (via OTP
  verification) — they cannot be unaware the order just completed.
- The rating prompt is already visible the next time either participant
  opens Activity (§10) — which both naturally do soon after, since
  that's where their in-progress orders already live.
- A second notification whose entire content is "go rate something"
  is close to the exact "noisy activity feed" pattern 3C's spec was
  written to avoid, for a marginal discoverability gain over what
  Activity already provides for free.

If real usage later shows people forgetting to rate, revisit as a
targeted addition — not now, without evidence.

## 12. 3B ranking integration — deferred, documented only

Not implemented in 3D. Documented relationship for a future milestone:

```
ratings → aggregate reputation (avg_rating, rating_count) → future
trust-weighted matching (3F, not before) → e.g. surfacing highly-rated
deliverers' pending requests more visibly, or letting a requester see a
prospective deliverer's rating before accepting
```

Reason to defer: at launch, most profiles will have zero or very few
ratings — folding an unreliable/near-empty signal into ranking now would
either do nothing (too sparse to matter) or, worse, be misleadingly
noisy (one 1-star rating tanking a new user's score from a single bad
match). Revisit once real rating volume exists to design a sensible
minimum-sample-size rule.

## 13. Migration requirements (staging only, `wemjskpbulebxgyhyhmk`)

1. `create table ratings (...)` + index + unique constraint (§4).
2. `alter table ratings enable row level security` + participant-only
   SELECT policy + explicit `revoke all` / `grant select` to
   `authenticated` only (§6) — applied in that order, not additively.
3. `submit_rating()` RPC (§5) + explicit revoke/grant execute (§6).
4. `get_profile_reputation()` RPC (§7) + explicit revoke/grant execute.
5. Live-verify immediately after applying (§6's verification plan) —
   before writing any frontend code against it, learning from 3C's
   sequencing mistake of verifying after the fact.

`profiles.rating` / `.successful_deliveries` / `.balance` are untouched
— no migration touches them in 3D.

## 14. Test strategy

**Authorization** (mirrors the task's list exactly):
- an outsider (not requester/deliverer on the order) calling
  `submit_rating` → rejected.
- self-rating is structurally impossible, not just rejected: the
  reviewee is always derived as "the other participant" — there is no
  code path where `reviewer_id = reviewee_id` could ever be produced,
  so this is a design proof, not just a test, but a test still asserts
  a requester can't pass their own id and get it accepted somehow.
- calling on a `pending`/`accepted`/`picked_up`/`out_for_delivery` order
  → rejected with "not delivered yet."
- calling on a genuinely `delivered` order, as either real participant
  → succeeds, in both directions.

**Uniqueness:**
- same reviewer calling `submit_rating` twice on the same order → second
  call rejected ("You already rated this order"), zero duplicate rows.

**Data integrity:**
- score outside 1–5 → rejected (both the RPC's explicit check and the
  table's CHECK constraint as defense-in-depth).
- comment over 300 chars → rejected by the CHECK constraint.
- a rating's `(order_id, reviewer_id, reviewee_id)` always corresponds
  to a real, delivered order those two people actually shared.

**Aggregation:**
- `get_profile_reputation` returns the correct average/count after N
  ratings.
- a profile with zero ratings returns null/0, never a fabricated value.
- `completed_deliveries` counts only `delivered` orders where the
  profile was `deliverer_id`, not `requester_id`, and not
  pending/active ones.

**UX (component-level, mocked hooks — matches this project's existing
test depth, e.g. `NotificationBell.test.tsx`):**
- rating prompt renders only for a delivered order the viewer hasn't
  already rated.
- prompt does not render for an already-rated order, or a
  non-delivered/cancelled one.
- invalid score (e.g. 0 stars) disables submit rather than allowing a
  bad request.
- submit shows a loading state and a friendly error on RPC rejection
  (e.g. the "already rated" race case).

**Staging E2E** (two disposable accounts, cleaned up after — same
discipline as 3C):
1. requester rates deliverer on a real delivered order → succeeds.
2. deliverer rates requester on the same order → succeeds.
3. either direction attempted twice → second attempt blocked.
4. a third, unrelated disposable account attempts to rate either
   participant on that order → rejected.
5. `get_profile_reputation` reflects the two new ratings correctly
   before cleanup removes them.

## 15. Accessibility

- The star input is a real, labeled control (e.g. a radio-group pattern
  or `aria-label="Rate N out of 5 stars"` per star), never a div-only
  click target with no accessible name.
- The confirmation ("Thanks — your rating was recorded.") is announced
  via the same toast mechanism already used elsewhere (`useToast`), not
  a new pattern.
- Profile's rating figures are plain text via the existing `Text`
  primitive — no icon-only rating display without a text equivalent
  (matches 3C's "never color/icon-only" rule for unread state).

## 16. Mobile behavior

- Rating entry reuses the existing Dialog (small, centered) or a bottom
  Sheet — whichever the implementation phase finds reads better inline
  in the "Earlier" list; either way, no new interaction primitive.
- Star targets sized to the same touch-target floor already established
  by `IconButton`'s `sm` variant (36px+, effectively 44px with padding).

## 17. Performance

- Profile: exactly one `get_profile_reputation` RPC call per page load.
- Activity: exactly one `select order_id from ratings where reviewer_id
  = auth.uid()` query per page load (not per row).
- No realtime subscription for ratings at all — nothing here needs to
  be pushed live; a rating appearing in someone's aggregate a few
  seconds late (next page load) is fine.
- No new query, subscription, or blocking call added to Home.

## 18. Explicitly deferred / open decisions

1. **Split rating-as-deliverer vs rating-as-requester into two separate
   averages?** Recommended: no, v1 uses one blended average per profile
   (simpler, still answers "can I trust this student" reasonably even
   though the two roles are semantically different asks). Revisit if
   real usage shows the blended number is confusing or gameable.
2. **Edit/delete** — deferred per §3, not rejected forever.
3. **A dedicated "rate this" notification** — deferred per §11.
4. **3B ranking integration** — deferred per §12.
5. **Recent rating trend** — not built; the task lists it as a
   "potential" signal only if justified, and there's no current evidence
   of a need (nor a natural place to show it without becoming a
   dashboard, which is explicitly out of scope for Profile).
6. **Whether to eventually drop `profiles.rating` /
   `.successful_deliveries` / `.balance` entirely** — out of scope for a
   feature milestone; flagged for a future cleanup pass, not touched
   here either way.
