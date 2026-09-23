# 3J — Trust & Safety Foundations (implementation specification, pending approval)

**Status: SPECIFICATION ONLY. No table, RPC, trigger, RLS policy, hook,
or UI component has been implemented.** Branch: `main` (unmodified —
this document is the only change). Everything below was traced directly
from the current repo at `617f9b4` — every migration file,
`src/hooks/useAuth.tsx`, `src/components/ProtectedRoute.tsx`,
`src/lib/validation.ts`, `src/lib/orderStatus.ts`, the chat/friendship
RLS policies, `src/pages/Login.tsx` — nothing here is assumed from an
older roadmap document.

---

## 1. Current-state audit

### Authentication / signup / session

`useAuth.tsx`'s `signUp()`: calls `supabase.auth.signUp({email, password,
options: {data: {full_name, phone}}})`, then — regardless of the
returned session's `email_confirmed_at` — immediately inserts a
`profiles` row and returns. `onAuthStateChange`'s callback sets `user`
to `{user: authUser, profile}` the moment any session exists, with
**no check of `authUser.email_confirmed_at` anywhere**. `ProtectedRoute.tsx`
gates purely on `user?.user` being truthy. `Login.tsx`'s own
`useEffect(() => { if (user) navigate('/') }, [user])` redirects to Home
the instant `user` becomes non-null.

**Empirically confirmed** (every disposable test account created
throughout this whole project, dozens of times, via `supabase.auth.signUp()`
against the staging project): a fresh signup returns an **immediately
usable session**, no confirmation step required. This means Supabase's
project-level "Confirm email" setting is currently **off** on staging.
This is a Supabase Dashboard setting, not something tracked in this repo
(`supabase/` has no `config.toml`; only `SETUP.sql` and migrations exist)
— production's setting is unverified from the code alone and must be
checked directly in the Supabase Dashboard before/during 3J rollout.

**Client-side domain check only**: `validation.ts`'s `VIT_EMAIL = /@vitstudent\.ac\.in$/i`,
enforced by Zod in `SignupSchema`/`LoginSchema`. Nothing server-side
constrains the email domain — a client bypassing the frontend entirely
(direct `supabase.auth.signUp()` call) can register any email address at
all; only the UI form refuses it.

**No resend/forgot-password flow exists anywhere in the codebase today**
— confirmed via full-repo search. 3J introduces the first "check your
email" UI pattern in this project; there is no existing convention to
extend.

### Order creation / acceptance / cancellation

`useOrders.ts`: `createOrder()` inserts directly (client-validated via
`PostOrderSchema`, no server-side validation function). `acceptOrder()`
does an atomic compare-and-swap (`.eq('status','pending').neq('requester_id',
delivererId)`), race-safe by construction — no SELECT-then-UPDATE window.
`cancelOrder()` similarly conditions the UPDATE on current status
(`in(validStatuses)`), with the real authorization backstop living in
the DB trigger `enforce_order_status_transition()` (3G), not the client
filter. **No table or function anywhere already implements any kind of
per-user rate limit** — confirmed via full-repo search for
`rate.limit|throttle|max.*per.*hour` etc.

### RLS / SECURITY DEFINER precedents already established

Every write-path table in this schema follows the same two shapes,
consistently, across 3D/3E/3G/3H/3I:

- **Direct-write tables** (`orders`, `chat_messages`): RLS `USING`/`WITH
  CHECK` clauses do the enforcement, no RPC needed, because the
  authorization rule is expressible as a row-level predicate.
- **RPC-mediated tables** (`ratings`, `friendships`, `user_preferences`
  writes go through `usePreferences.ts` directly since they're pure
  owner-scoped CRUD, but the read-aggregate functions and the
  friendship-lifecycle mutations are `SECURITY DEFINER` RPCs): revoke-all
  first, grant only `select` (or nothing) to the table itself, and put
  all the actual business logic — self-action prevention, state
  validation, identity resolution from `auth.uid()`, never from a
  client parameter — inside a `security definer` function with
  `set search_path = public, pg_temp`.

**Chat RLS** (`chat_select_participant`/`chat_insert_participant`,
`20260824120000_rls_policies_and_indexes.sql`): both scoped to
`order_id in (select id from orders where requester_id = auth.uid() or
deliverer_id = auth.uid())` — chat only ever exists in the context of a
shared order, there is no freestanding DM.

**Friendships** (3E, `20260828100000_social_graph.sql`): a genuinely
strong precedent for 3J's `blocks` table —
`friendships_no_self_friend check (requester_id <> addressee_id)`,
a **canonical-unordered-pair unique index**
(`unique index on (least(a,b), greatest(a,b))`) preventing both A→B+B→A
duplicates and repeat A→B rows, and five `SECURITY DEFINER` RPCs
(`send_friend_request`, `accept_friend_request`, `decline_friend_request`,
`cancel_friend_request`, `remove_friend`) that are the *only* write path
— the table itself has zero client `INSERT`/`UPDATE`/`DELETE` grants.
**Important distinction for 3J**: friendship is symmetric (A and B end up
in the same relationship either way), so the canonical-pair unique index
is correct there. **Blocking is directional** (A blocking B is not the
same fact as B blocking A) — the canonical-pair pattern must NOT be
reused verbatim for `blocks`; see §4.

**Notification suppression precedent** (3H,
`20260831100000_user_preferences.sql`): `notify_new_chat_message()`/
`notify_friend_request()`/`notify_friend_accepted()` each gained one
`if exists (select 1 from user_preferences where ... and <pref> = false)
then return new/old; end if;` guard before their existing insert — this
is the exact shape block-based notification suppression should follow
(§4/§7).

### Order statuses / lifecycle

`orders_status_check`: `status in ('pending', 'accepted', 'picked_up',
'out_for_delivery', 'delivered', 'cancelled')` — six values, unchanged
since `20260824120100_order_status_integrity.sql`. `orderStatus.ts`
mirrors this exactly with `ORDER_STATUS_TRANSITIONS`, `ACTIVE_STATUSES`
(`pending, accepted, picked_up, out_for_delivery`), `TERMINAL_STATUSES`
(`delivered, cancelled`) — both consumed throughout Activity
(`OrderingActive`/`DeliveringActive`/`*History`) and Home's discovery
pipeline. `cancelled_at`/`cancelled_by` (3G) are both **nullable** —
`cancelled_by` already has no `NOT NULL` constraint, and the frontend
already handles a null `cancelled_by` (pre-3G legacy cancelled orders)
by falling back to `created_at` for the history date and treating a
null `cancelled_by` as "not cancelled by me" — this existing null-handling
is directly reusable for system-driven expiry (§6).

### Home discovery / Activity — what "stale" would need to plug into

`useOrders.fetchOrders()`'s public-feed branch: `else if (!filters?.status
|| filters.status === 'all') { query = query.eq('status', 'pending') }`
— this is the exact query Home's board uses. `orders_select_pending_feed`
RLS policy: `using (status = 'pending')` — the exact policy that makes
every pending order visible to every signed-in user regardless of
participation. Activity's `OrderingActive.tsx`/`DeliveringActive.tsx`
call `fetchOrders({mine: {...}, statusIn: ACTIVE_STATUSES})` — a
requester's own pending order stays in their Activity/Ordering active
view via this path, entirely separate from the public board query.

### Reputation / ratings — confirms no existing consequence for cancellation

`get_profile_reputation()` (3D): `avg_rating`/`rating_count` (from
`ratings`) + `completed_deliveries` (`count(*) from orders where
deliverer_id = p and status = 'delivered'`) — **cancellation never
appears in this function at all**, confirming the audit finding that
cancellation currently has zero visible trust consequence. 3J's scope
(per your explicit instruction) does not change this — flagged again in
§12 as excluded, not silently fixed.

---

## 2. Email verification

**Mandatory for 3J, per explicit product decision**: Supabase Auth's
email-confirmation setting is currently **disabled** on this project
(confirmed empirically in §1 — every signup throughout this entire
project has returned an immediately-usable session with no confirmation
step). 3J's design assumes this is turned **on** as part of this
milestone, not left as a future option. The full flow below — enabling
it, restricting registration to `@vitstudent.ac.in`, and gating
protected functionality on verification — is the actual mandatory scope
of §2, not a nice-to-have layered on top of a smaller default.

### Design: use Supabase's built-in email-confirmation, gate at the app layer, do not build a second identity system

**Mechanism**: enable Supabase Auth's standard "Confirm email" flow
(Dashboard setting; already the platform-native mechanism `supabase.auth.signUp()`
already triggers when that setting is on — no new provider, no custom
token system). Every `User` object Supabase already returns carries
`email_confirmed_at: string | null` — **this field already exists on
every session today, unread by any code in this repo.** No schema
change, no new table. This directly satisfies "do not invent a second
identity system."

**What changes**:

1. **`useAuth.tsx`**: `AuthUser` gains a derived `emailVerified: boolean`
   (from `session.user.email_confirmed_at != null`) — a computed field
   on the existing `User` object, not a new DB column. `signUp()`
   unchanged in shape (still creates the `profiles` row immediately —
   see "what happens to an unverified account" below for why).
2. **`ProtectedRoute.tsx`**: gains a second check. Unverified users are
   **not** redirected to `/login` (they have a real, valid session) —
   they're redirected to a new lightweight route, e.g. `/verify-email`,
   *except* for a small allowlist of routes that must remain reachable
   (see below).
3. **`Login.tsx`**: after a successful `signUp()` call, navigate to
   `/verify-email` instead of relying on the generic `user`-truthy
   redirect to `/`.
4. **New route** `/verify-email`: shows "We sent a link to
   `{email}`. Check your inbox." + a "Resend" button
   (`supabase.auth.resend({type: 'signup', email})` — an existing
   Supabase client method, no new backend code) with a client-side
   cooldown (e.g., 60s) to avoid trivially spamming Supabase's own
   send-email endpoint — this is a UX courtesy, not the real rate limit
   (Supabase's own email-sending has its own platform-level throttling;
   3J does not need to reimplement that).

### What an unverified account can/cannot do — the actual product decision

Per your explicit instruction to avoid unnecessarily locking users out
of useful functionality unless there's a strong reason, and given the
signup flow already creates a real `profiles` row immediately (not
gated on confirmation), the recommended policy is:

| Action | Unverified allowed? | Reasoning |
|---|---|---|
| View `/verify-email` itself, resend | ✅ Always | Has to be reachable to ever become verified |
| Sign out | ✅ Always | Never trap a user in a dead-end session |
| View/edit own Profile (name/phone), change password | ✅ Allowed | Fixing a typo'd signup detail or a forgotten password shouldn't require verification first — no trust-sensitive action here |
| View Home / browse the board | 🟡 Recommended: allowed, read-only sense of the product | Seeing what CampusLink is (browsing, not transacting) costs nothing and helps a new signup understand the app while their inbox catches up — but see the P0 case below |
| **Post an order** | ❌ Blocked until verified | The exact scenario 3J exists to prevent: an unverified identity asking real students to hand over food/money-adjacent trust |
| **Accept an order** | ❌ Blocked until verified | Same reasoning — an unverified account becoming someone's deliverer is the higher-risk direction, not lower |
| **Send a chat message** | ❌ Blocked until verified | Chat only exists in the context of an order either action already blocks; this is enforced as a consequence, not a separate gate |
| **Send a friend request** | ❌ Blocked until verified | Same reasoning as ordering — initiating contact with a real student |
| View/respond to Activity, Settings, Insights | ✅ Allowed | Non-trust-sensitive; an already-accepted order from before this feature shipped (see "existing users" below) must remain manageable |

This means `/verify-email` is not a hard wall in front of the whole app
— it's a banner/gate on the *specific* actions that create real
obligations between two students (post, accept, message, friend-request),
matching the audit's own framing of the actual risk. **Enforcement must
be both client-side (hide/disable the actions, with a clear "Verify
your email to do this" message) and server-side** (§7) — the client
gate is UX, the RLS/RPC gate is the real boundary, per your explicit
instruction that this must survive a malicious client.

### Expired/invalid verification links

Supabase's confirmation links have their own platform-level TTL; a
click past expiry surfaces a Supabase-generated error on redirect back
to the app. The app-side handling needed: `/verify-email` (or a small
`/auth/callback` route, if Supabase's redirect lands there instead)
must catch that error state and show "This link expired — request a new
one" with the same Resend action, rather than a raw/blank error.

### Existing (pre-3J) accounts and staging/test accounts

Every account created before 3J ships has `email_confirmed_at = null`
in Supabase's own `auth.users` table (since confirmation was never
required at signup time) — **applying this gate would suddenly lock out
every current real user**, including any of the disposable
`e2e-*@vitstudent.ac.in` staging accounts used throughout this whole
project's own verification work. Two real options:

- **A. Grandfather everyone who signed up before the 3J rollout date** —
  a one-time backfill (`update auth.users set email_confirmed_at = now()
  where email_confirmed_at is null and created_at < '<rollout timestamp>'`)
  applied once, by hand, against each environment at deploy time — not a
  tracked migration (this touches Supabase's own `auth` schema, which
  this repo's migrations have never touched, by design — see 3G/3H/3I's
  own consistent "additive only, never touches auth schema" convention).
- **B. Require everyone to re-verify**, with the unverified-account
  action gate above meaning existing users simply see the gate on their
  next post/accept/message attempt and resend from there.

**Recommendation: A for real deployments, explicit opt-out for
staging.** Locking out every real existing user the moment 3J ships
is a genuinely bad rollout experience for zero security benefit (those
accounts already have whatever trust history they've built up over
prior phases); grandfathering is a one-time, auditable, reversible SQL
statement, not a new system. Staging's disposable test accounts don't
need grandfathering at all (each verification pass in this project has
always created *fresh* accounts and cleaned them up) — but this is
explicitly listed as a decision for you to confirm, not something this
spec locks in (§14/§15).

### Guaranteeing someone can't register someone else's email and use the app immediately

This is exactly what "blocked until verified" (the table above)
guarantees: even though the account exists and can sign in the instant
`signUp()` returns, **it cannot post, accept, message, or friend-request
until the confirmation link — sent only to the real inbox — is clicked.**
Someone registering `realstudent@vitstudent.ac.in` without owning that
inbox gets a working *login*, but never a working *account* in any
trust-sensitive sense, because they can never click a link in an inbox
they don't control. This is the actual guarantee your requirement is
asking for, delivered by Supabase's existing mechanism, not a new one.

### Required Supabase Dashboard configuration (not code — must be set per environment)

These are project-level settings, not anything this repo's migrations
have ever touched (consistent with 3G/3H/3I's own "never touches the
`auth` schema" convention) — but they are **mandatory, not optional**
parts of 3J's scope, and must be applied to staging and production
separately:

1. **Authentication → Providers → Email → "Confirm email": ON.** This is
   the single toggle that makes `email_confirmed_at` actually get set
   only after a real click, instead of immediately. Currently OFF on
   staging (§1); production's setting must be checked directly, not
   assumed from this repo.
2. **Authentication → URL Configuration → Site URL**: must point at the
   real deployed app URL for each environment (not `localhost`, once
   staging/production are the target) — this is what Supabase uses to
   build the confirmation link's redirect target.
3. **Authentication → URL Configuration → Redirect URLs (allowlist)**:
   must explicitly include every URL the app is actually served from —
   at minimum `http://localhost:<dev-port>/**` (local development),
   the staging deployment's URL, and the production deployment's URL,
   each with the appropriate path (`/verify-email` or wherever the
   confirmation link should land, per the app-side route design above).
   **A confirmation link whose redirect target isn't on this allowlist
   fails silently/is rejected by Supabase** — this is a common, easy-to-miss
   deployment mistake and must be explicitly verified per environment
   before 3J is considered done, not assumed to "just work" because it
   worked in one environment.
4. **Authentication → Emails → SMTP settings**: Supabase's default
   built-in email sending (no custom SMTP configured) is:
   - **Rate-limited at the platform level** to a small number of emails
     per hour, shared across every auth email type (confirmation,
     password reset, magic link, etc.) — not per-type.
   - **Sent from a shared Supabase sending domain**, not
     `@campuslink...` or any address a recipient would recognize —
     this affects both deliverability (more likely to land in spam,
     since it's not your domain's own reputation) and trust (a VIT
     student has no way to visually confirm the email is legitimate).
   - **Explicitly documented by Supabase as unsuitable for production
     use** — this is a platform-stated limitation, not a guess.

   This is fine, unchanged, for this project's own disposable-account
   testing pattern (a handful of signups per staging session), but is
   **not sufficient for real rollout to actual VIT students** — even at
   the modest "first ~100 students" scale you described, both the
   rate limit and the deliverability/trust problem apply from the very
   first real batch of signups, not just at large scale.

   **What "configuring a custom SMTP provider" actually requires**, so
   the technical shape of the decision is clear regardless of which
   vendor is eventually chosen:
   - An account with a **transactional email provider** (any SMTP
     provider Supabase supports is fine — this spec deliberately does
     not evaluate or recommend one).
   - **A sending domain you control**, with the provider's required
     DNS records (SPF, DKIM, and usually a return-path/CNAME record)
     added to that domain — this is what lets receiving mail servers
     (e.g. Gmail, which most VIT students likely use) trust the email
     enough not to spam-box it, and is unrelated to which provider is
     picked.
   - The resulting **SMTP host, port, username, and password/API key**
     entered into Supabase's Authentication → Emails → SMTP settings
     page — this is the entire integration surface; Supabase does not
     need any other code change to use it.
   - Most transactional-email providers' **free tier** covers several
     thousand emails/month, which comfortably covers a "first ~100
     students" rollout (each student needs only 1 confirmation email,
     plus occasional resends) — a paid plan is not a prerequisite for
     this phase, whichever provider is eventually chosen.

   This is flagged as a required pre-launch configuration action,
   deliberately **not implemented, decided, or defaulted to any specific
   provider by this spec** (§15 decision list) — the requirement is
   architectural (Supabase needs *a* configured SMTP provider before
   real students sign up); the vendor choice is yours to make separately,
   on your own timeline, and does not block approval or implementation
   of the rest of 3J (the app can run against Supabase's default sender
   through staging/testing/early rollout, and SMTP can be swapped in
   later purely as a Dashboard configuration change — no code or
   migration in this repo depends on which provider is used, or on one
   being configured at all).
5. **Authentication → Emails → Confirm signup template** (optional but
   recommended): the default Supabase template is generic; customizing
   it to mention "CampusLink" and set expectations ("click to unlock
   posting and messaging") is a low-effort improvement, not a hard
   requirement for 3J to function.

### Server-side `@vitstudent.ac.in` enforcement — closing the gap the client-only regex leaves open

**Critical distinction from §1's audit finding**: enabling Supabase's
email-confirmation setting proves *ownership* of whatever email address
was given — it does **not** by itself restrict *which* email domains
may register at all. Today, `VIT_EMAIL` (`validation.ts`) is a **client-side
Zod check only** — a request that bypasses the frontend entirely (a
direct `supabase.auth.signUp({email: 'anyone@gmail.com', ...})` call)
is not restricted by anything server-side today, confirmed by inspecting
every migration in this repo: nothing constrains `auth.users.email`'s
domain at the database level. Turning on email confirmation alone would
correctly verify that *whatever* address was used is real and owned by
the signer-upper — including a real, ownable `gmail.com` address. **This
does not satisfy "only `@vitstudent.ac.in` accounts can register" on its
own.**

**Domain is exact and fixed, per explicit confirmation**: `@vitstudent.ac.in`
only. Not broadened to `@vit.ac.in`, `@vitstudent.ac.in`'s subdomains, or
any staff/faculty domain — the trigger's pattern below matches this and
only this, deliberately.

**Design**: a `BEFORE INSERT` trigger on `auth.users`, rejecting any row
whose `email` doesn't match the VIT domain — the actual, un-bypassable
server-side equivalent of the existing client regex, hardened against
the specific failure modes below:

```sql
create or replace function public.enforce_vit_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Administrative/system inserts are exempt, not the signup path
  -- itself: this project has no OAuth provider configured (confirmed -
  -- src/hooks/useAuth.tsx only ever calls signUp()/signInWithPassword(),
  -- no signInWithOAuth anywhere in the codebase) and no admin-user-creation
  -- feature exists today, so this branch is not exercised by any current
  -- code path - it exists so a *future* legitimate administrative action
  -- (e.g. the Supabase Dashboard's own "Add user" admin operation,
  -- issued as the service_role, which also inserts into auth.users and
  -- would otherwise be blocked by this same trigger with no way around
  -- it) is never silently broken by a rule meant only to constrain
  -- self-service signup.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  -- Fail safe, not fail open, on a malformed/null email - a null or
  -- empty email should never have reached this point in a normal
  -- signup (Supabase's own auth flow requires one), but if it
  -- somehow did, the correct behavior is to reject, not to let a
  -- vacuous regex match let it through.
  if new.email is null or btrim(new.email) = '' then
    raise exception 'A valid email address is required'
      using errcode = 'check_violation';
  end if;

  -- Case-insensitive by construction (~* is the case-insensitive regex
  -- operator, matching VIT_EMAIL's own /i flag in validation.ts exactly)
  -- - "Student@VITStudent.AC.IN" must be accepted exactly like
  -- "student@vitstudent.ac.in" is.
  if new.email !~* '^[^@[:space:]]+@vitstudent\.ac\.in$' then
    raise exception 'Only @vitstudent.ac.in email addresses may register'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists auth_users_enforce_vit_domain on auth.users;
create trigger auth_users_enforce_vit_domain
  before insert on auth.users
  for each row execute function public.enforce_vit_email_domain();
```

This is the one place in 3J's entire design that touches the `auth`
schema directly with a *structural* object (a trigger, not a one-time
backfill like the grandfather step) — flagged explicitly because it
breaks this project's own long-standing "migrations never touch `auth`"
convention, for a deliberate, necessary reason (there is no other
server-side hook point that runs before a row lands in `auth.users`).
This must be applied and verified exactly like every other migration in
this project — confirmed live against staging before being considered
correct, not assumed from reading the trigger body alone. See "Proving
the trigger is safe" below for the exact required verification steps.

### Existing accounts and this trigger — why it cannot break them

**A `BEFORE INSERT` trigger only ever fires on new rows being inserted —
it structurally cannot affect, block, delete, or re-evaluate any row
already sitting in `auth.users`.** Every account created before this
trigger exists is completely unaffected by it, by definition, forever —
there is no retroactive enforcement, no scan of existing rows, no risk
of the migration itself failing partway through because of a
pre-existing "bad" row (an `INSERT`-only trigger has nothing to check
against the existing table contents at all).

This was also verified empirically against the actual current staging
database rather than left as a theoretical claim: **all 34 existing
`auth.users` rows on staging already have a `@vitstudent.ac.in` email
address — zero non-VIT-domain emails, zero null emails.** This is
consistent with the client-side `VIT_EMAIL` check having been in place
since before this project's `main` branch existed, and confirms there is
no latent non-compliant account anywhere in the current dataset that
this migration would need special handling for. Production's data has
not been inspected as part of this specification pass (this repo's
migrations only ever apply to staging directly; production application
is a separate, explicit step per every prior phase's own convention) —
the same check (`select count(*) from auth.users where email !~* '...'`)
should be run against production before this migration is applied there,
purely as a sanity confirmation, not because the trigger's own
correctness depends on the result.

**No migration or grandfathering step is required for existing accounts
with respect to the domain trigger specifically** — that concern only
applies to the separate `email_confirmed_at` grandfathering question
(§ above), which is about *confirmation status*, not *domain*, and is
already addressed as its own decision point.

### Proving the trigger is safe — required verification, not assumed

Per your explicit instruction, each of the following must be
demonstrated against real staging (not inferred from the SQL alone)
before this migration is considered correct:

1. **Normal signup through Supabase still works**: a fresh, real
   `@vitstudent.ac.in` address completes `supabase.auth.signUp()`
   successfully, with no behavior change from today (this is the
   trigger's `return new` path — must be confirmed to still return the
   *same* successful result shape the app already depends on).
2. **No OAuth/admin operations are broken**: confirmed by code
   inspection that this codebase has no OAuth provider configured
   today (only `signUp()`/`signInWithPassword()` exist in
   `useAuth.tsx`), so there is no OAuth signup path to break — this is
   a non-issue *today*, not a risk being carried forward silently. The
   `service_role` exemption above exists specifically so that if an
   admin operation is ever added later (or is used ad hoc via the
   Supabase Dashboard), it is not surprised by this trigger.
3. **Existing migrations/users are unaffected**: re-run this project's
   full existing migration set against a clean database with this
   trigger included, confirm no other migration fails (none of them
   insert into `auth.users` — confirmed via full-repo search — so this
   is expected to be a non-event, but must be confirmed by actually
   running it, not assumed).
4. **Case-insensitive matching is correct**: a signup attempt with
   `Student@VITStudent.AC.IN` (mixed case) is accepted; one with
   `student@VITSTUDENT.AC.IN.evil.com` (a domain *containing* the VIT
   string but not *ending* with it) is rejected — confirming the regex's
   `^...@vitstudent\.ac\.in$` anchoring is doing real work, not just
   substring matching.
5. **Malformed/null emails fail safely**: a direct SQL insert attempt
   with `email = null` or `email = ''` is rejected with the "valid email
   address is required" exception, not a silent pass-through or an
   unrelated Postgres error.
6. **A direct API bypass attempt is rejected**: `supabase.auth.signUp({email:
   'anyone@gmail.com', ...})`, called directly (not through the app's
   UI/frontend at all), fails at the database layer — this is the actual
   proof that the security boundary is server-side, not merely that the
   frontend form happens to refuse the same input.

### Fresh-account end-to-end flow (explicit, for the test plan in §10)

The complete, mandatory happy path this design must support, stated
explicitly since it's the actual acceptance criterion for §2:

1. Sign up with a real, ownable `@vitstudent.ac.in` address → account +
   `profiles` row created, session active, `email_confirmed_at` is
   `null`.
2. Land on `/verify-email`; a real confirmation email arrives at the
   real inbox (requires SMTP to actually be configured per-environment,
   above).
3. Click the link → redirected back to the app at a URL that must be on
   the Redirect URLs allowlist for that environment → Supabase sets
   `email_confirmed_at` → the app's next `onAuthStateChange` emission
   (or an explicit re-check on landing) reflects `emailVerified: true`.
4. Gated actions (post, accept, message, friend-request) become
   available with no further action needed.
5. Signing out and back in later still shows the account as verified
   (persisted on the Supabase-side `auth.users` row, not anything
   client-cached).

A parallel, equally mandatory unhappy path: attempting `signUp()` with a
non-`@vitstudent.ac.in` address is rejected **both** by the existing
client-side Zod validation (immediate, no network round trip) **and**,
if that's bypassed, by the new `auth_users_enforce_vit_domain` trigger
(§ above) — both must be independently verified in the test plan (§10),
not just the client path.

---

## 3. Rate limiting / abuse prevention

### Architecture: one small `SECURITY DEFINER` helper, called from inside each existing write RPC/policy — no new infrastructure

The smallest design compatible with this codebase's existing shape is a
single reusable table + function, reused by every rate-limited action,
rather than one bespoke mechanism per action:

```sql
create table if not exists rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now()
);
create index on rate_limit_events (user_id, action, created_at desc);
```

A single `stable`... actually `volatile` (it inserts) `SECURITY DEFINER`
function:

```sql
create or replace function public.check_and_record_rate_limit(
  p_action text, p_limit integer, p_window_minutes integer
) returns boolean -- true = allowed, false = limit hit (row NOT inserted)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_count integer;
begin
  select count(*) into v_count from rate_limit_events
    where user_id = auth.uid() and action = p_action
      and created_at > now() - (p_window_minutes || ' minutes')::interval;
  if v_count >= p_limit then return false; end if;
  insert into rate_limit_events (user_id, action) values (auth.uid(), p_action);
  return true;
end; $$;
```

This is deliberately **not** the same shape as `submit_rating()`/
`send_friend_request()` (which each *are* the write path) — instead it's
a small, reusable precondition, called at the top of `createOrder()`,
`sendMessage()`, `sendFriendRequest()`, and `acceptOrder()`'s existing
insert/RPC paths (see §11 for exactly which functions each migration
touches). Enforcement is **entirely server-side** — a malicious client
calling the underlying `orders`/`chat_messages` insert or the
`send_friend_request` RPC directly, bypassing the frontend completely,
still hits this check inside the RPC/trigger, because it's not
expressed as a client-optional parameter but as a mandatory internal
call keyed on `auth.uid()`.

**Per-action limits** (initial, conservative, explicitly flagged as a
decision for you in §14 rather than silently finalized):

| Action | Limit | Window | Scope | Rationale |
|---|---|---|---|---|
| Order creation | 5 | 60 min | per user | A real student posts a handful of errands a day at most; 5/hour comfortably covers legitimate bursts (e.g. posting for several friends) while blocking a scripted flood |
| Friend requests sent | 10 | 60 min | per user | Generous enough for genuine networking, low enough to stop a request-spam bot |
| Chat messages | 30 | 10 min | per user, **per order** (not global) | A real, fast back-and-forth during an active handoff can legitimately be rapid; scoping per-order (not per-user-globally) means one busy conversation never throttles a user's ability to message on a *different* order |
| Order acceptance attempts | 10 | 10 min | per user | The atomic compare-and-swap already makes a failed accept cheap and harmless, but a scripted client hammering `acceptOrder` on every pending order the instant it's posted is exactly the "sniping bot" scenario this should prevent |

**What happens when exceeded**: the RPC/insert raises a clear exception
(`raise exception 'Please slow down - try again in a few minutes'
using errcode = '<custom>'`, matching `submit_rating()`'s/
`enforce_order_status_transition()`'s existing "raise a readable
message, not a generic constraint-violation string" convention) — the
frontend's existing `getErrorMessage(err, fallback)` pattern (used
identically in every existing mutation handler) already surfaces this
as a toast without any new error-handling infrastructure.

**Legitimate use stays unaffected**: every limit above is set well above
observed/plausible real usage from this entire project's own staging
testing (the busiest single manual test session in this whole project
never posted more than 2-3 orders or sent more than a handful of chat
messages in any 10-minute window) — the limits exist to stop scripted
abuse, not to constrain a real student's actual usage pattern.

**No external infrastructure** (no Redis, no edge middleware, no
third-party rate-limit service) — a plain Postgres table + count query
is genuinely sufficient at this scale, and keeps the entire mechanism
inside the same Supabase project every other feature already lives in.

---

## 4. Block system

### Schema: directional, not the friendships canonical-pair pattern

```sql
create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint blocks_no_self_block check (blocker_id <> blocked_id),
  constraint blocks_unique_pair unique (blocker_id, blocked_id)
);
create index on blocks (blocked_id);
```

Directional by design (a simple `unique(blocker_id, blocked_id)`, **not**
the `least/greatest` canonical-pair index friendships uses) — A blocking
B does not imply B has blocked A, and the system must be able to
represent "A blocked B, B has not blocked A" and "both blocked each
other" as two independent facts, which the friendships pattern cannot
express. `blocks_no_self_block` mirrors `friendships_no_self_friend`'s
exact shape. Duplicate-block prevention is the plain `unique(blocker_id,
blocked_id)` constraint — a second `block(A,B)` call simply fails/no-ops
via `on conflict do nothing` inside the RPC, never a client-visible
error for what's really an idempotent "still blocked" state.

### RLS + write path

```sql
alter table blocks enable row level security;
create policy "blocks_select_own" on blocks for select using (blocker_id = auth.uid());
revoke all on blocks from anon, authenticated;
grant select on blocks to authenticated;
-- writes only via block_user()/unblock_user() RPCs below.
```

A user can only ever `SELECT` their *own* blocks (who *they've* blocked)
— never who has blocked *them* (that would itself be a privacy leak: it
would let someone confirm "this specific person blocked me," which is
exactly the kind of signal that invites retaliation). `block_user(p_blocked_id
uuid)`/`unblock_user(p_blocked_id uuid)`: `SECURITY DEFINER`, self-block
guarded exactly like `send_friend_request`'s existing self-request guard,
`auth.uid()` as `blocker_id` always, never a client parameter.

### How blocking must actually change behavior (the real design work)

The block relationship needs to be **checked from every place two users'
identities currently interact**, not just hidden in the UI. Concretely:

| Surface | Change needed | Where |
|---|---|---|
| **Chat** | `chat_insert_participant` RLS gains `and not exists (select 1 from blocks where (blocker_id = auth.uid() and blocked_id = <counterpart>) or (blocker_id = <counterpart> and blocked_id = auth.uid()))` — **either direction blocks messaging**, since a message from the blocked party is exactly what blocking exists to stop, and a message *to* someone who blocked you should also fail (silently, from the sender's perspective — see below) | New policy version of `chat_insert_participant` |
| **Friend requests** | `send_friend_request()` gains the same bidirectional existence check before insert, raising the existing "you cannot..." exception shape | `send_friend_request()` |
| **Existing friendship** | Blocking someone you're currently friends with should **also remove the friendship** — a block that leaves a "friends" relationship intact is incoherent (the whole point is severing contact). `block_user()` itself deletes any existing `friendships` row between the pair as part of the same transaction | `block_user()` RPC body |
| **Order discovery (Home board)** | `orders_select_pending_feed`'s `using (status = 'pending')` is deliberately **not** modified to filter by blocks — the public board is anonymous-until-accepted browsing; there is no requester identity shown on the board itself before acceptance (confirmed: `Home.tsx`'s `OrderCard` never renders `requester_profile.name`). A block cannot meaningfully hide "an order exists" without knowing whose order it is, which the board doesn't expose | No change to this policy |
| **Accepting a blocked person's order** | `orders_update_accept`'s `with check (deliverer_id = auth.uid())` gains `and not exists (select 1 from blocks where (blocker_id = auth.uid() and blocked_id = orders.requester_id) or (blocker_id = orders.requester_id and blocked_id = auth.uid()))` — the moment a deliverer would become paired with a blocked requester (or vice versa), the accept attempt fails at the DB layer, with the client's existing "This order was already accepted" fallback message covering it gracefully (no new error copy needed — see §7's note on this) | `orders_update_accept` policy |
| **Notifications** | Mirrors 3H's exact preference-guard pattern: every notification-inserting trigger (`notify_order_status_change`, `notify_new_chat_message`, `notify_friend_request`, `notify_friend_accepted`) gains `and not exists (select 1 from blocks where ...)` before its insert | Four existing trigger functions |

### Existing active orders / friendships / conversations at the moment of blocking

This is the tradeoff you explicitly asked to have spelled out rather
than assumed:

- **A blocks B while they have an active (non-terminal) order together**:
  **recommendation: the order lifecycle is unaffected.** Blocking does
  not auto-cancel, does not change status, does not touch `orders` at
  all. Reasoning: an active order represents a real, already-in-motion
  physical handoff (food already picked up, a deliverer already en
  route) — silently cancelling it because of a block could strand a
  requester mid-delivery or leave a deliverer holding an item with
  nowhere to deliver it, which is a *worse* safety outcome than leaving
  the existing 3G cancellation flow (still fully available to either
  party, unchanged) as the mechanism to actually stop the order if
  needed. The block instead prevents any *future* pairing.
- **A blocks B while a chat thread already exists on a still-active
  order**: **recommendation: existing messages remain visible to both
  (chat history is not deleted or hidden), but new messages from either
  side into that thread are blocked** — same bidirectional RLS check as
  above, applied uniformly regardless of whether the order is old or
  active. If this breaks a genuinely necessary in-progress coordination
  (e.g., "which gate are you at"), that's the accepted tradeoff of
  choosing to block someone you're actively transacting with — the
  existing 3G cancellation path is still the correct tool if the order
  itself needs to stop.
- **A blocks B while they are friends**: friendship is removed as part
  of the same `block_user()` transaction (above).
- **B attempts to contact A afterward** (message, friend request):
  **fails silently from B's perspective** — the RLS/RPC rejection should
  surface to B as the *same generic error* an ordinary failure would
  ("Couldn't send message. Please try again.") rather than "You have
  been blocked by this user," which would itself be a harassment vector
  (confirming to a blocker-avoider exactly who blocked them, inviting a
  second account or retaliation). This mirrors the "who has blocked me"
  privacy reasoning above.
- **A unblocks B**: `unblock_user()` simply deletes the `blocks` row.
  **Friendship is not automatically restored** — unblocking undoes the
  block, it doesn't retroactively re-friend; B would need to send a new
  friend request if desired. Chat/order-acceptance capability between
  them is restored immediately (the same RLS checks simply stop
  matching once the row is gone).

---

## 5. Report system

### Schema

```sql
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references profiles(id) on delete cascade,
  reported_user_id uuid not null references profiles(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  reason text not null check (reason in (
    'no_show', 'unsafe_behavior', 'harassment', 'inappropriate_content',
    'suspected_fake_account', 'other'
  )),
  description text check (description is null or char_length(description) <= 500),
  created_at timestamptz not null default now(),
  constraint reports_no_self_report check (reporter_id <> reported_user_id)
);
create index on reports (reported_user_id);
```

`order_id` is nullable and `on delete set null` (not `cascade`) —
a report must survive even if the underlying order is later deleted
(never happens today — orders are never hard-deleted anywhere in this
schema — but this is the correct, defensive default for a
moderation-evidence table regardless). `reason` is a fixed enum
(mirrors `notifications.type`'s own `check (type in (...))` convention)
rather than freeform text, so future moderation tooling can filter/sort
reliably; `description` is optional free text, capped at 500 chars
(same bound-length convention `ratings.comment` already uses).

### RLS + write path

```sql
alter table reports enable row level security;
create policy "reports_select_own" on reports for select using (reporter_id = auth.uid());
revoke all on reports from anon, authenticated;
grant select on reports to authenticated;
-- insert only via file_report() RPC.
```

A reporter can see their own filed reports (so the UI can show "you
reported this" state) but — critically — **cannot see reports filed
against them, and cannot see anyone else's reports**, satisfying "not
expose private reports to normal users." There is deliberately **no
`UPDATE`/`DELETE` grant or RPC at all** — a report, once filed, is
immutable, satisfying "a reporter should not be able to modify someone
else's report" trivially (they can't modify *any* report, including
their own, which is the correct, simpler rule for a V1 moderation-signal
table with no moderation workflow yet).

```sql
create or replace function public.file_report(
  p_reported_user_id uuid, p_order_id uuid, p_reason text, p_description text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_allowed boolean;
begin
  if p_reported_user_id = auth.uid() then
    raise exception 'You cannot report yourself';
  end if;

  select public.check_and_record_rate_limit('file_report', 5, 1440) into v_allowed; -- 5/day
  if not v_allowed then
    raise exception 'You have reported the maximum number of times today';
  end if;

  insert into reports (reporter_id, reported_user_id, order_id, reason, description)
  values (auth.uid(), p_reported_user_id, p_order_id, p_reason, nullif(trim(p_description), ''))
  returning id into v_id;
  return v_id;
end; $$;
```

**Report spam prevention** reuses §3's `check_and_record_rate_limit`
directly (5 reports/day, generous for genuine use, low enough that
mass-reporting one user to trigger some future auto-action stays
implausible) — no separate mechanism needed. `p_order_id` is
deliberately **not validated against "were you actually a participant
on this order"** in V1 — a student should be able to report a *profile*
they encountered anywhere (chat, a friend request, a name search
result) without an order necessarily existing; when an order context is
available the UI passes it, when it isn't, `p_order_id` is `null`. This
keeps the write path simple and matches "capture trustworthy signals,
not build a workflow" — a future moderation pass can weight
order-linked reports differently from context-free ones without any
schema change.

### UI placement

- **Profile** (viewing someone else's, e.g. from a search result or an
  order's counterpart panel): a small "Report" text link, same visual
  weight/placement as `CancelOrderDialog`'s existing destructive-toned
  text-link trigger (not a prominent button) — reporting should be
  available, not encouraged as a first-class action.
- **Order detail** (`ActiveOrdersSection`'s expanded view, both
  Ordering and Delivering): a "Report [counterpart name]" link near the
  existing cancel action, passing the current `order_id` — this is the
  single most natural entry point, since most real reports will
  originate from a specific bad interaction on a specific order.
- **Chat**: no separate report entry point inside `ChatThread` itself —
  the order-detail-level "Report" link (directly above the chat panel
  in the same expanded view) already covers this without adding a
  second, redundant control inside the thread.
- **Block system's own UI** (Profile's block/unblock action) gets a
  "Report" option alongside it, since the two actions are often taken
  together, but they remain two distinct actions/RPCs, never merged
  into one "block and report" combo call.

Deliberately **not** added: a global "Report" entry in the main nav or
Settings — this would be exactly the "giant Safety Center" your
instruction says to avoid without genuine reason; contextual entry
points at the two places a real bad interaction actually happens
(a specific order, a specific profile) are sufficient for V1.

---

## 6. Order expiry / stale orders

### Comparing the four approaches

- **A. Client-side stale filtering only** (Home hides an order older
  than N hours, but the DB/RLS never enforces it): rejected — it's not
  a real safety/quality mechanism, since a modified client (or anyone
  hitting the API directly) still sees and can accept a week-old order;
  fails "must survive a malicious client" the same way pure frontend
  rate-limiting would.
- **B. Server-side status/state change** (a new `expired` status, or
  flipping to `cancelled`): real enforcement, but a new status value
  means altering `orders_status_check`, `enforce_order_status_transition()`'s
  transition graph, `orderStatus.ts`'s `ORDER_STATUS_TRANSITIONS`/
  `ACTIVE_STATUSES`/`TERMINAL_STATUSES`, and every place in Activity/Home
  that switches on status — a wide, invasive ripple for what should be
  a narrow feature, and directly conflicts with your instruction to
  avoid unnecessary new statuses "if avoidable."
- **C. A scheduled job** (`pg_cron` periodically flipping stale pending
  orders): real enforcement, but introduces new operational
  infrastructure (a cron job that must be monitored, that runs even
  when nobody's using the app, that needs its own failure handling) for
  a problem that doesn't actually need periodic background work — see D.
- **D. RLS-enforced time-window filtering, computed live, no new status,
  no new column, no scheduled job** (recommended): treat "stale" as a
  *computed* property of `created_at`, checked at read/write time by
  the RLS policies themselves, exactly the same pattern
  `orders_select_pending_feed` already uses for `status = 'pending'`.

**Recommended design (D)**:

```sql
-- orders_select_pending_feed, updated:
using (status = 'pending' and created_at > now() - interval '12 hours')

-- orders_update_accept, updated:
using (status = 'pending' and deliverer_id is null
       and created_at > now() - interval '12 hours')
```

No new column, no new status, no new table, no scheduled job — a stale
pending order simply stops matching the public-feed and accept-eligible
policies once it crosses the threshold, computed fresh on every query
(cheap: a single `interval` comparison against an already-indexed
`created_at`). This is genuinely the smallest change that still gives
real, un-bypassable enforcement (both read exposure *and* the accept
path are closed, not just the board display).

### Defined behavior

- **Exact threshold**: 12 hours, recommended as a reasonable default for
  a same-day campus errand (long enough to cover someone posting in the
  morning and it still being live for an evening pickup shift, short
  enough that a truly abandoned order doesn't linger for days) — flagged
  explicitly as a decision for you in §14/§15, not silently finalized.
- **Requester's own view**: **unaffected** — `orders_select_participant`
  (`requester_id = auth.uid() or deliverer_id = auth.uid()`) has no time
  bound, so the requester still sees their own stale order in
  `OrderingActive.tsx` exactly as before, still genuinely `pending`,
  still cancellable via the existing, unmodified 3G flow.
- **Does it appear in History?** No — `TERMINAL_STATUSES` is unchanged,
  a stale-but-still-`pending` order is still active by every existing
  definition; it correctly stays out of `OrderingHistory.tsx` (which
  only shows `delivered`/`cancelled`) until the requester either lets it
  get accepted (impossible once stale, per the accept-policy change
  above) or explicitly cancels it.
- **Can it be revived?** **No revive mechanic in V1** — since nothing
  about the order's own data changed (only visibility/acceptability,
  both purely a function of `created_at`, which cannot be "reset"
  without fabricating a new creation time), the only path back to
  visibility is cancel-and-repost, which is already how "I made a
  mistake" is handled today (§14 explicitly notes order-editing is a
  separate, excluded milestone) — this keeps 3J from quietly growing
  into an editing feature.
- **Notifications**: none needed — since no status actually changes,
  none of the four `notify_*` triggers fire differently; the requester
  simply never receives an "accepted" notification because it never
  becomes acceptable, which is the correct, silent behavior (no new
  "your order expired" notification type is introduced, keeping scope
  tight — flagged as a reasonable future addition, not built here).
- **Timestamp interpretation**: `created_at` only, `now()` computed
  server-side inside the policy (never a client-supplied "current time,"
  which would trivially defeat the whole mechanism).

---

## 7. Security / RLS design summary

| Object | SELECT | INSERT | UPDATE | DELETE | anon EXECUTE | authenticated EXECUTE | SECURITY DEFINER? | Boundary |
|---|---|---|---|---|---|---|---|---|
| `rate_limit_events` | none (no policy at all — nobody, including the owner, reads this table directly) | none | none | none | n/a | n/a | n/a | Only ever touched from inside `check_and_record_rate_limit()`, which runs as its owner |
| `check_and_record_rate_limit()` | n/a | n/a | n/a | n/a | ❌ | ✅ (called internally by other functions, not directly exposed to the client as a standalone action a user would invoke) | ✅ | `auth.uid()` is the only identity ever used — never a parameter |
| `blocks` | own rows only (`blocker_id = auth.uid()`) | via RPC only | via RPC only (unblock is a delete, not update) | via RPC only | ❌ | ✅ (table SELECT); RPCs below | ✅ (RPCs) | `blocker_id` always `auth.uid()`, never client-supplied |
| `block_user(uuid)` / `unblock_user(uuid)` | n/a | n/a | n/a | n/a | ❌ | ✅ | ✅ | Self-block guarded exactly like `send_friend_request` |
| `reports` | own filed reports only (`reporter_id = auth.uid()`) | via RPC only | none (immutable) | none (immutable) | ❌ | ✅ (table SELECT); RPC below | ✅ (RPC) | `reporter_id` always `auth.uid()`; reported-against visibility deliberately excluded |
| `file_report(...)` | n/a | n/a | n/a | n/a | ❌ | ✅ | ✅ | Self-report guarded; rate-limited via `check_and_record_rate_limit` |
| `orders_select_pending_feed` (modified) | (policy, not a table) | — | — | — | — | — | — | Adds `created_at > now() - interval '12 hours'` to the existing predicate — strictly narrower than before, never broader |
| `orders_update_accept` (modified) | — | — | (policy) | — | — | — | — | Adds the staleness bound **and** the bidirectional block-exclusion subquery — both strictly narrowing |
| `chat_insert_participant` (modified) | — | (policy) | — | — | — | — | — | Adds the bidirectional block-exclusion subquery — strictly narrowing |
| `notify_order_status_change()` / `notify_new_chat_message()` / `notify_friend_request()` / `notify_friend_accepted()` (modified) | n/a | n/a | n/a | n/a | ❌ (already) | ✅ (already, triggers only) | ✅ (already) | Each gains one additional `and not exists (select 1 from blocks where ...)` guard, same shape as 3H's existing preference guards |

**No existing policy is weakened** — every modification above is a
strict narrowing (`AND`-ing in an additional condition) of an existing
`USING`/`WITH CHECK` clause, never a replacement that removes an
existing check, matching your explicit instruction.

---

## 8. UX design

**Signup / `/verify-email`**: "We sent a verification link to
`{email}`. Click it to unlock posting and messaging on CampusLink." +
"Resend email" (60s cooldown, disabled state with a visible countdown,
matching the existing `Button`'s `loading`/`disabled` prop conventions
already used everywhere else in this codebase) + a small "Wrong email?
Sign out and try again" link.

**Anywhere a gated action is attempted while unverified** (PostRequest's
submit button, Home's "Take" button, `ChatThread`'s send, Friends'
"Add"): the action itself stays visible (not hidden — hiding it would
be confusing, since the user doesn't know *why* it's gone) but shows an
inline message + link on attempt: "Verify your email to do this. →
Resend verification". This is a UI-level courtesy on top of the real
server-side block (§2/§7) — reflects the existing project convention of
never trusting client-only gating for anything that actually matters.

**Profile** (viewing someone else's): "Block" (ghost-variant text
button, same visual tier as existing destructive actions like
`CancelOrderDialog`'s trigger) → confirmation dialog (reusing the
`Dialog` primitive, same shape as `CancelOrderDialog`/`RatingDialog`) →
on confirm, calls `block_user`. If already blocked: the same slot shows
"Unblock" instead. "Report" sits beside it, opens a small form (radio
group of the fixed reasons + optional textarea, same `Dialog` shape).

**Chat / Orders**: "Report [name]" link in the order detail's action
row, next to the existing cancel action — same `CancelOrderDialog`-style
trigger weight, not a prominent button.

**Home**: no new UI element for staleness — a stale order simply stops
appearing (§6), consistent with how a delivered/cancelled order already
silently leaves the board today; no "X hours old" countdown or badge is
introduced (keeps this from becoming a second, competing signal
alongside the existing `posted {timeAgo}` caption already on every
`OrderCard`).

**Rate-limit errors**: surfaced through the exact same toast pattern
every other mutation in this app already uses
(`getErrorMessage(err, fallback)` → `toast({title, description,
variant: 'destructive'})`) — no new error-UI component, just a readable
message string from the RPC's `raise exception`.

No "Safety Center" page is introduced — every surface above is a small,
contextual addition to a screen that already exists.

---

## 9. Existing-feature regression analysis

- **3G cancellation**: entirely untouched — no policy or trigger 3G
  introduced is modified by anything in this spec. Blocking/reporting/
  verification never intersect the cancellation path.
- **3H live GPS / preferred areas**: entirely untouched — 3J touches
  zero preference/discovery code or policy.
- **Ranking/trust tiers (3B/3F)**: entirely untouched — 3J does not
  read or write `distance_km`/`distance_source`, and does not change
  what appears in `rankRecommended`'s inputs. (Blocking does **not**
  filter the ranked board — see §4's explicit reasoning that the public
  board doesn't expose requester identity pre-acceptance.)
- **Activity Ordering/Delivering/History**: unaffected in shape — a
  stale order simply stops being *acceptable* by someone else, which
  has no effect on the requester's own Ordering-active view (§6); a
  blocked pairing can never have existed as an active order in the
  first place (blocked at acceptance, §4), so History's rendering logic
  needs no change.
- **OTP / delivery tracking**: untouched — both are scoped to an
  already-active, already-paired order; 3J's block check happens strictly
  *before* a pairing can form (at accept time), never after, so no
  already-OTP-eligible or already-tracking order is ever affected
  mid-flight by a block (consistent with §4's explicit "active orders
  unaffected by blocking" policy).
- **Ratings/reputation**: untouched — `submit_rating()`/
  `get_profile_reputation()` are not modified; 3J does not add
  cancellation or block/report signal into reputation (explicitly
  excluded, §12).
- **3I analytics/Campus Insights**: untouched functionally, but note
  for awareness — `get_campus_order_volume()`'s `count(*) from orders
  where created_at >= ...` is **unaffected** by the staleness RLS change,
  because that function is `SECURITY DEFINER` and does not go through
  `orders_select_pending_feed`/`orders_update_accept` at all; a stale
  order still correctly counts toward "orders posted" in Insights
  (accurate — it *was* posted, staleness is about current
  visibility/acceptability, not historical fact). No change needed to
  any 3I function.
- **Chat**: message *history* is never deleted/hidden by a block (§4) —
  `ChatThread.tsx`'s existing rendering is unaffected; only the RLS
  `INSERT` path gains the new predicate, so old messages remain exactly
  as visible as before.

---

## 10. Test plan

### Unit
- Email regex/domain validation (existing `validation.test.ts` coverage
  extended, not replaced).
- `check_and_record_rate_limit`-equivalent client wrapper: correct
  action/limit/window params passed per call site.
- Stale-order date-math boundary conditions (11h59m vs 12h01m) — tested
  at the RLS/query level via a mocked `createQueryBuilder`, same
  pattern `useOrders.test.ts` already uses for its `statusIn`/`limit`
  filters.
- Block-state derivation logic (e.g., a `isBlocked`/`hasBlockedMe`
  hook helper, if one is introduced) in isolation.

### Component
- `/verify-email` page: shows the right email, resend cooldown behavior,
  expired-link error state.
- Gated-action UI (PostRequest submit, Home "Take", chat send, Friends
  "Add") correctly shows the verify-prompt when `emailVerified === false`
  and behaves exactly as today when `true`.
- Block/unblock button + confirmation dialog, correct state toggle.
- Report dialog: reason selection required, description length-capped,
  submit disabled until valid (mirrors `RatingDialog`'s existing
  "Submit disabled until a star is picked" pattern).
- Stale order genuinely absent from `Home.tsx`'s rendered board once
  the mocked `useOrders` fixture's `created_at` crosses the threshold
  (this specific check has to happen at the RLS/fetch layer, so the
  component test here is really "Home renders whatever `useOrders`
  returns," with the *real* enforcement tested at the DB/RLS level
  below — do not conflate a passing component test here with proof of
  real enforcement).

### Database (direct RPC/RLS tests, run against real staging, not mocks)
- A stranger account cannot `select` another user's `blocks`/`reports`
  rows directly.
- Duplicate `block_user(same target)` call is a no-op, not an error.
- `block_user(self)` raises the expected exception.
- `file_report(self)` raises the expected exception.
- An account past the report rate limit is rejected on the 6th call
  within the window.
- A blocked-in-either-direction pair cannot insert into `chat_messages`
  for a shared order, verified via a **direct RPC/insert call bypassing
  the frontend entirely** (per your explicit instruction).
- A blocked-in-either-direction pair's `orders_update_accept` attempt
  fails at the DB layer, same direct-call verification.
- An unverified account's direct `insert` into `orders`/`chat_messages`
  or direct `send_friend_request` call fails at the DB layer (not just
  hidden in the UI).
- A stale (>12h) pending order no longer appears in a stranger's
  `orders_select_pending_feed`-scoped query, and a direct accept attempt
  on it fails.
- `check_and_record_rate_limit` genuinely blocks the (N+1)th call within
  the window and allows the (N+1)th call once the window has rolled
  forward (tested with a manipulated `created_at` on inserted
  `rate_limit_events` rows, or a short test-only window).

### Integration
- Signup → `/verify-email` → (simulate confirmation) → gated actions
  become available.
- Blocked user's chat-send attempt fails and surfaces the same generic
  error a real send failure would (never "you were blocked").
- Filing a report persists correctly and is retrievable only by the
  reporter.
- A stale order disappears from Home's board fetch but remains in the
  requester's own Activity/Ordering-active view.
- An active order survives a block being placed on its counterpart
  (order unaffected, per §4).

### Staging E2E (disposable accounts, real browser, mirroring every
prior phase's own convention in this project)
- **Fresh-account signup → email → verification → login** (§2's explicit
  happy path, mandatory): a genuinely fresh disposable `@vitstudent.ac.in`
  address signs up, a real email is received (requires SMTP configured
  on the environment under test), clicking the real link redirects back
  to a URL that must already be on that environment's Redirect URLs
  allowlist, `email_confirmed_at` is confirmed set via a direct DB
  check, and every previously-gated action (post/accept/message/friend-request)
  is confirmed to work immediately afterward with no further steps.
- **Non-VIT domain rejection, both layers**: a direct (frontend-bypassing)
  `supabase.auth.signUp()` call with a non-`@vitstudent.ac.in` address
  is confirmed rejected by the `auth_users_enforce_vit_domain` trigger,
  independent of and in addition to the existing client-side Zod check.
- **Resend + expired-link handling**: trigger a resend, confirm a second
  real email arrives; confirm an expired/already-used link surfaces the
  app's own "request a new one" state rather than a raw Supabase error.
- Full signup → verify → post an order → accept from a second account →
  complete lifecycle, confirming nothing in 3G/OTP/tracking regressed.
- Two disposable accounts: A blocks B mid-friendship → confirm
  friendship row is gone, confirm B's subsequent message attempt fails,
  confirm A's existing chat history with B (if any, pre-block) still
  renders for A.
- File a report from a real account, confirm only that account can read
  it back.
- Manually backdate a disposable test order's `created_at` via direct
  SQL (same technique used throughout every prior phase's staging
  verification in this project) past the 12h threshold, confirm it
  disappears from a stranger's board fetch and a direct accept attempt
  fails, while the requester's own Activity view still shows it.
- Confirm the existing 3G cancellation E2E flow (from the original 3G
  verification) still passes unmodified.

---

## 11. Migration strategy

| # | Filename (illustrative, not created) | Purpose | Objects touched | Additive? | Rollback | Data migration? |
|---|---|---|---|---|---|---|
| 1 | `..._email_verification_grandfather.sql` | One-time backfill of `email_confirmed_at` for pre-3J accounts | `auth.users` (Supabase-managed schema — same caveat as every prior phase: apply by hand per environment, not as a tracked repo migration in the usual sense, since this repo's migrations have never touched the `auth` schema) | N/A (one-time UPDATE) | Cannot be cleanly rolled back (would need to null out `email_confirmed_at` again for the exact backfilled set — capture the affected user-id list before running) | Yes — this *is* the data migration |
| 1b | `..._enforce_vit_email_domain.sql` | `BEFORE INSERT` trigger on `auth.users` rejecting non-`@vitstudent.ac.in` signups server-side (§2) | `auth.users` (structural — the one exception to this project's "never touches `auth` schema" convention, deliberate and necessary) | Yes | `drop trigger`/`drop function` | No |
| 2 | `..._rate_limit_events.sql` | `rate_limit_events` table + `check_and_record_rate_limit()` | New table, new function, new index | Yes | Drop table/function — no other object depends on it | No |
| 3 | `..._order_rate_limits.sql` | Wire rate-limit checks into order creation/acceptance | `createOrder()`'s underlying insert path (likely needs a thin `SECURITY DEFINER` wrapper RPC if `orders` INSERT is to gain a rate-limit check without moving the whole insert server-side — see open question in §15) | Yes, additive | Revert the wrapper, restore direct-insert path | No |
| 4 | `..._chat_friend_rate_limits.sql` | Rate-limit chat messages and friend requests | `chat_insert_participant` policy (or a new `send_chat_message()` RPC, same open question as #3), `send_friend_request()` | Yes | Revert the added checks | No |
| 5 | `..._blocks.sql` | `blocks` table, RLS, `block_user()`/`unblock_user()` | New table, 2 new functions | Yes | Drop table/functions | No |
| 6 | `..._block_enforcement.sql` | Thread block checks through chat/accept/notifications | `chat_insert_participant`, `orders_update_accept`, the four `notify_*` trigger functions | Yes (strict narrowing only) | `create or replace` each function back to its pre-3J body (keep the old bodies in the migration's own comments, same convention every prior "fix"/"restrict" migration in this repo already follows) | No |
| 7 | `..._reports.sql` | `reports` table, RLS, `file_report()` | New table, new function | Yes | Drop table/function | No |
| 8 | `..._stale_order_expiry.sql` | Time-bound `orders_select_pending_feed`/`orders_update_accept` | 2 existing policies | Yes (strict narrowing) | `create policy` back to the pre-3J `using` clause | No |

Recommended ordering rationale is in §13. Migrations 3/4 have an open
architectural question (§15) that should be resolved before they're
written, not decided implicitly by whichever approach is easiest to
code.

---

## 12. Scope control — explicitly excluded

- Admin role/dashboard — no privilege model exists in this schema at
  all (confirmed in the prior product audit); not introduced here.
- Moderation dashboard/workflow — `reports` captures signal only, per
  your instruction; nothing reads/actions reports yet.
- Cancellation-based reputation scoring — `get_profile_reputation()` is
  not modified; cancellation remains reputation-invisible, exactly as
  today (flagged in the original product audit as a real gap, but a
  distinct, separate product-design decision from "capture a report" —
  not silently folded into 3J).
- Payments — nothing in 3J requires it; blocking/reporting/verification/
  rate-limiting/expiry are all identity- and behavior-layer concerns,
  not money-layer ones.
- AI — none of the five features benefit from it; reason selection
  (§5) is a fixed enum, not free-text classification.
- Advanced analytics — 3J does not touch 3I; no new metric is added
  (a future "reports filed" aggregate is a plausible 3I extension, not
  built here).
- Push notification infrastructure — unrelated; existing in-app
  notification model is unaffected in mechanism, only gains block
  guards (§4/§7).
- Full identity/KYC — explicitly out of scope; email-domain verification
  is the agreed bar, not government-ID or biometric verification.
- Complex content moderation — no message/content scanning, no
  auto-flagging; reports are entirely user-initiated.
- Dispute-resolution workflow — a report is captured, not adjudicated;
  no refund/compensation/arbitration mechanism exists or is implied.

**Nothing found during this design pass needs to be added back** — the
five approved features, as designed above, don't structurally require
any of the excluded items to function correctly at V1 scope.

---

## 13. Implementation order

Recommended sequence, based on dependency direction and blast-radius
risk (safest/most isolated first):

1. **`blocks` table + RPCs + RLS-select-own** (§4, without the
   enforcement wiring yet) — fully additive, zero interaction with any
   other existing table, safest possible starting point, and its own
   RPCs can be fully tested in isolation before anything depends on them.
2. **`reports` table + RPC** (§5) — same reasoning, fully additive,
   zero interaction with any existing table besides a read of `orders`
   for the optional `order_id` FK (no policy change to `orders` itself).
3. **`rate_limit_events` + `check_and_record_rate_limit()`** (§3) — additive,
   but now needs the architectural decision from §15 resolved before
   wiring it into `orders`/`chat_messages`/`send_friend_request`.
4. **Block enforcement wiring** (chat/accept/notification guards, §4/§7)
   — depends on #1 existing; this is the step with the most existing-file
   touches (four trigger functions + two policies), so it should follow
   only after #1's own table/RPCs are independently verified correct in
   staging.
5. **Rate-limit wiring into orders/chat/friend-requests** — depends on
   #3 and on the §15 architectural decision; do this after #4 so any
   staging test data generated while validating block enforcement isn't
   also fighting a not-yet-tuned rate limit.
6. **Stale-order expiry** (§6) — fully independent of everything above
   (touches only `orders_select_pending_feed`/`orders_update_accept`,
   which #4 also touches for a *different* reason) — sequence this
   **after** #4/#5 specifically so the two sets of `orders_update_accept`
   changes are combined into one final policy version instead of two
   separate `create or replace policy` migrations fighting each other.
7. **Email verification** (§2) — deliberately **last**, not first,
   despite being the headline feature: it's the one piece that changes
   *existing user* behavior (via the grandfather backfill) and touches
   `ProtectedRoute`/`Login.tsx` (files every other page depends on
   rendering through), so it should land only once every other new
   surface (block/report UI, rate-limit error copy) already exists to
   be gated correctly, and once the grandfather-backfill decision (§2)
   is confirmed.
8. **Full regression/E2E verification** — the complete staging pass
   from §10's E2E section, run once, against the fully-assembled 3J
   feature set, not once per migration.

---

## 14. Final spec decision table

| Feature | Build in 3J? | Reason | Complexity | Risk |
|---|---|---|---|---|
| Email verification (Supabase-native, action-gated not full-lockout) | ✅ Yes | Directly closes the P0 identity gap | Medium (touches `ProtectedRoute`/`Login`/every gated-action call site) | Medium (grandfather-backfill decision affects every current real user) |
| Rate limiting (orders, friend requests, chat, accept attempts) | ✅ Yes | Directly closes the P0 abuse gap | Low-medium (one reusable mechanism, several call sites) | Low (strictly additive checks) |
| Block system | ✅ Yes | Directly closes a P1 trust gap | Medium (touches 2 policies + 4 trigger functions) | Medium (must not weaken existing chat/accept policies — mitigated by strict-narrowing-only rule, §7) |
| Report system | ✅ Yes | Directly closes a P1 trust gap, captures signal for future moderation | Low | Low (fully additive, no interaction with existing tables beyond an optional FK) |
| Order expiry (RLS time-window, no new status) | ✅ Yes | Directly closes a P1 product gap | Low | Low (2 policies, strict narrowing, no new schema) |

### Exact files likely to change
`src/hooks/useAuth.tsx`, `src/components/ProtectedRoute.tsx`,
`src/pages/Login.tsx`, `src/lib/database-types.ts` (new
`Block`/`Report`/`AuthUser.emailVerified` types), new
`src/pages/VerifyEmail.tsx`, new `src/hooks/useBlocks.ts`, new
`src/hooks/useReports.ts`, `src/hooks/useOrders.ts`/`useFriends.ts`/
`useChat.ts` (surfacing new rate-limit/block error messages — no
structural change to their existing functions), `src/App.tsx` (new
route), `src/pages/Profile.tsx` (block/report entry points),
`src/components/activity/ActiveOrdersSection.tsx` (report entry point).

### Exact migrations likely required
The 8 listed in §11.

### Existing files that must NOT be touched
Anything in 3G's cancellation trigger/policies, 3H's
`usePreferences.tsx`/`useDiscoveryLocation.ts`/discovery filtering,
Activity's `useOrders.fetchOrders`'s `statusIn`/`limit` mechanism
itself (only the two named policies gain predicates — the client-side
query shape is unchanged), 3I's four analytics RPCs, `ratings`/
`get_profile_reputation()`.

### Expected test count impact
Roughly 60-90 new tests estimated across the unit/component/database/
integration tiers in §10, based on this project's own established
density (3H added ~65, 3I added ~24, Activity added ~140) — a
mid-sized feature set by this project's own historical scale.

### Expected UX changes
One new route (`/verify-email`), small additive UI on Profile
(block/report) and order detail (report), inline gated-action messaging
on PostRequest/Home/Chat/Friends — no redesign of any existing screen.

### Security impact
Net positive — closes 2 P0s and 3 P1s from the prior audit; every
policy change is a strict narrowing, never a widening (§7).

### Data/privacy impact
Two new tables holding sensitive-but-owner-scoped data (`blocks`,
`reports`) — both correctly locked to owner-only `SELECT`, matching
this project's established privacy bar (3H's `user_preferences`, 3D's
`ratings`). No new location or message-content data is introduced.

---

## 15. Final recommendation

**YELLOW — needs product decisions before implementation.**

The architecture itself is sound and directly reuses this codebase's
own established patterns throughout (no RED-level redesign needed), but
five concrete decisions are genuinely yours to make, not mine to guess:

1. **Email-verification grandfathering** (§2): confirm option A
   (backfill `email_confirmed_at` for every pre-3J account) vs. B
   (require everyone, including existing users, to re-verify) — this
   materially changes rollout risk for any real existing users.
2. **Exact rate-limit numbers** (§3): the table given is a reasoned
   starting point, not a locked-in decision — confirm or adjust before
   implementation, since these are inherently product-judgment calls
   about what "normal" usage looks like.
3. **Exact stale-order threshold** (§6): 12 hours is a recommendation,
   not a decision — confirm or adjust.
4. **Architecture for rate-limiting `orders`/`chat_messages` inserts**
   (referenced in §11, migrations #3/#4): both tables are currently
   inserted into **directly** by the client (`useOrders.createOrder()`,
   `useChat.sendMessage()`), not through a `SECURITY DEFINER` RPC —
   unlike `ratings`/`friendships`, which already funnel every write
   through a function. Adding a rate-limit check to a direct-insert
   table requires either (a) converting order/chat creation to go
   through a new wrapper RPC (a real, if small, architectural change to
   how two core, high-traffic tables are written), or (b) expressing
   the rate limit as a `BEFORE INSERT` trigger on `orders`/`chat_messages`
   that calls `check_and_record_rate_limit()` internally (no RPC
   conversion needed, stays closer to today's shape). **(b) is the
   recommended approach** — it preserves the existing direct-insert
   pattern entirely and only adds a trigger, exactly mirroring how 3G's
   `enforce_order_status_transition()` already sits as a trigger on
   `orders` doing exactly this kind of "reject before it's written"
   enforcement — but this is flagged explicitly as a decision, not
   silently chosen, since it does mean rate-limit rejections surface as
   a Postgres trigger exception rather than an RPC's `raise exception`
   (same end result for the frontend's `getErrorMessage` handling, but
   worth your sign-off on the mechanism).
5. **Whether unverified users may browse Home at all** (§2's table) —
   recommended "yes, read-only," but this is a real product-tone
   decision (some products prefer a harder wall) worth your explicit
   confirmation.
6. **SMTP provider for real email delivery** (§2): Supabase's default
   built-in sender is fine for continued staging/dev testing but is
   explicitly documented by Supabase as unsuitable for production
   (low platform-level rate limit, shared/untrusted sending domain).
   Before real students sign up, a transactional SMTP provider needs a
   sending domain with SPF/DKIM configured, and its SMTP
   host/port/credentials entered into the Supabase Dashboard — this is
   a pure Dashboard configuration step with no code or migration
   dependency in this repo. **Which provider is entirely your choice**;
   this spec deliberately does not evaluate or recommend one, and this
   decision does not block approving or implementing the rest of 3J —
   it can be configured any time before production launch, independent
   of everything else in this phase.
7. **Confirm the Redirect URLs allowlist per environment** (§2) —
   specifically, the exact production deployment URL (and any staging
   URL still in active use) must be entered into Supabase's Dashboard
   before that environment's confirmation links will work at all; this
   is operational configuration, not something this spec or any
   migration can set for you.

Once these seven are confirmed, the design in this document is ready to
implement following the order in §13.

---

## Final Git State

- Current branch: `main`
- HEAD SHA: `617f9b4ce5be5b13428fa10ce2e6c3342ec560b1`
- Working tree status: clean before this document, and after — the only
  change made during this specification pass is this file itself
- **No source files were modified**
- **No migrations were created**
- **Nothing was committed**
- **Nothing was pushed**
- **`main` was not changed** beyond the addition of this untracked
  specification file
