-- Friend-to-friend direct messages (separate from order chat).
--
-- chat_messages stays exactly as it is: it is tied to an order and has
-- its own policies, rate limit and notifications. Direct messages get
-- their own two tables so the two can never be mixed up.
--
--   direct_conversations  one row per unordered pair of users. user_a <
--                         user_b is enforced, so (A,B) and (B,A) are the
--                         same row and duplicates are structurally
--                         impossible.
--   direct_messages       sender_id / recipient_id are both stored, so
--                         RLS and the Realtime filter never need a join.
--
-- Write paths (nothing is trusted from the client):
--   * conversations: only get_or_create_direct_conversation() (RPC).
--   * messages: direct insert of (conversation_id, sender_id, body) only;
--     a BEFORE INSERT trigger sets recipient_id itself and rejects the
--     insert unless the sender is a participant, the pair are accepted
--     friends, neither has blocked the other, the sender's email is
--     verified, and the rate limit allows it.
--   * read status: only mark_direct_conversation_read() (RPC).
--
-- Policy on removed friends: history stays readable to both participants
-- (same as blocks - see 20260903130000_block_enforcement.sql), but new
-- messages are rejected by the trigger as soon as the friendship is gone.
--
-- Realtime: the table is added to the supabase_realtime publication so
-- postgres_changes events are delivered. Events are filtered by RLS per
-- subscriber, so a user only ever receives their own messages.

-- ============ TABLES ============

create table if not exists direct_conversations (
  id uuid primary key default gen_random_uuid(),
  user_a uuid not null references profiles(id) on delete cascade,
  user_b uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint direct_conversations_canonical_order check (user_a < user_b),
  constraint direct_conversations_pair_unique unique (user_a, user_b)
);

create index if not exists direct_conversations_user_b_idx
  on direct_conversations (user_b);

create table if not exists direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references direct_conversations(id) on delete cascade,
  sender_id uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index if not exists direct_messages_conversation_created_idx
  on direct_messages (conversation_id, created_at desc);

create index if not exists direct_messages_recipient_unread_idx
  on direct_messages (recipient_id) where read_at is null;

-- ============ RLS + GRANTS ============

alter table direct_conversations enable row level security;
alter table direct_messages enable row level security;

drop policy if exists "direct_conversations_select_participant" on direct_conversations;
create policy "direct_conversations_select_participant"
  on direct_conversations for select
  using (auth.uid() = user_a or auth.uid() = user_b);

drop policy if exists "direct_messages_select_participant" on direct_messages;
create policy "direct_messages_select_participant"
  on direct_messages for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

-- sender_id must be the caller. Friendship/block/verification/rate-limit
-- checks live in the trigger below (they need to read other tables).
drop policy if exists "direct_messages_insert_own" on direct_messages;
create policy "direct_messages_insert_own"
  on direct_messages for insert
  with check (auth.uid() = sender_id);

revoke all on direct_conversations from anon, authenticated;
revoke all on direct_messages from anon, authenticated;
grant select on direct_conversations to authenticated;
grant select on direct_messages to authenticated;
-- Column-level insert: recipient_id, created_at and read_at can never be
-- supplied by a client.
grant insert (conversation_id, sender_id, body) on direct_messages to authenticated;

-- ============ INSERT GUARD ============

create or replace function public.enforce_direct_message_rules()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conv direct_conversations%rowtype;
  v_other uuid;
  v_allowed boolean;
begin
  if auth.uid() is null or new.sender_id <> auth.uid() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  select * into v_conv from direct_conversations where id = new.conversation_id;
  if not found or auth.uid() not in (v_conv.user_a, v_conv.user_b) then
    raise exception 'Conversation not found';
  end if;

  v_other := case when v_conv.user_a = auth.uid() then v_conv.user_b else v_conv.user_a end;

  -- FOR SHARE locks the friendship row until this transaction ends, so a
  -- concurrent remove_friend() (a DELETE) waits for this insert instead of
  -- racing past the check: the message either lands before the unfriend
  -- or is rejected after it.
  perform 1 from friendships
    where status = 'accepted'
      and ((requester_id = auth.uid() and addressee_id = v_other)
        or (requester_id = v_other and addressee_id = auth.uid()))
    for share;
  if not found then
    raise exception 'You can only message accepted friends';
  end if;

  if public.is_blocked_pair(auth.uid(), v_other) then
    raise exception 'Couldn''t send message. Please try again.';
  end if;

  if not public.current_user_email_verified() then
    raise exception 'Verify your email before sending a message'
      using errcode = 'insufficient_privilege';
  end if;

  -- check_and_record_rate_limit() is count-then-insert with no locking, so
  -- N concurrent sends can all read the same count and every one pass.
  -- Serialising per (user, conversation) for the rest of this transaction
  -- makes the limit exact without touching the shared function.
  perform pg_advisory_xact_lock(
    hashtextextended('direct_message:' || auth.uid()::text || ':' || new.conversation_id::text, 0)
  );

  select public.check_and_record_rate_limit('direct_message:' || new.conversation_id::text, 30, 10)
    into v_allowed;
  if not v_allowed then
    raise exception 'Please slow down - try again in a few minutes'
      using errcode = 'P0001';
  end if;

  new.recipient_id := v_other;
  new.read_at := null;
  new.body := btrim(new.body);
  return new;
end;
$$;

revoke all on function public.enforce_direct_message_rules() from public, anon, authenticated;

drop trigger if exists direct_messages_enforce_rules on direct_messages;
create trigger direct_messages_enforce_rules
  before insert on direct_messages
  for each row
  execute function public.enforce_direct_message_rules();

-- ============ RPCs ============

create or replace function public.get_or_create_direct_conversation(p_friend_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := auth.uid();
  v_a uuid;
  v_b uuid;
  v_id uuid;
begin
  if v_me is null then
    raise exception 'Not signed in' using errcode = 'insufficient_privilege';
  end if;
  if p_friend_id is null or p_friend_id = v_me then
    raise exception 'Invalid conversation';
  end if;

  if not exists (
    select 1 from friendships
    where status = 'accepted'
      and ((requester_id = v_me and addressee_id = p_friend_id)
        or (requester_id = p_friend_id and addressee_id = v_me))
  ) then
    raise exception 'You can only message accepted friends';
  end if;

  if public.is_blocked_pair(v_me, p_friend_id) then
    raise exception 'Couldn''t open this conversation';
  end if;

  v_a := least(v_me, p_friend_id);
  v_b := greatest(v_me, p_friend_id);

  insert into direct_conversations (user_a, user_b)
  values (v_a, v_b)
  on conflict (user_a, user_b) do nothing;

  select id into v_id from direct_conversations where user_a = v_a and user_b = v_b;
  return v_id;
end;
$$;

revoke all on function public.get_or_create_direct_conversation(uuid) from public, anon;
grant execute on function public.get_or_create_direct_conversation(uuid) to authenticated;

create or replace function public.get_my_direct_conversations()
returns table (
  conversation_id uuid,
  friend_id uuid,
  friend_name text,
  last_message text,
  last_message_at timestamptz,
  last_sender_id uuid,
  unread_count integer,
  can_message boolean
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    c.id,
    f.id,
    f.name,
    lm.body,
    lm.created_at,
    lm.sender_id,
    (select count(*)::integer from direct_messages m
      where m.conversation_id = c.id and m.recipient_id = auth.uid() and m.read_at is null),
    exists (
      select 1 from friendships fr
      where fr.status = 'accepted'
        and ((fr.requester_id = auth.uid() and fr.addressee_id = f.id)
          or (fr.requester_id = f.id and fr.addressee_id = auth.uid()))
    ) and not public.is_blocked_pair(auth.uid(), f.id)
  from direct_conversations c
  join profiles f on f.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  left join lateral (
    select m.body, m.created_at, m.sender_id
    from direct_messages m
    where m.conversation_id = c.id
    order by m.created_at desc
    limit 1
  ) lm on true
  where auth.uid() in (c.user_a, c.user_b)
  order by lm.created_at desc nulls last, c.created_at desc;
$$;

revoke all on function public.get_my_direct_conversations() from public, anon;
grant execute on function public.get_my_direct_conversations() to authenticated;

create or replace function public.mark_direct_conversation_read(p_conversation_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update direct_messages
     set read_at = now()
   where conversation_id = p_conversation_id
     and recipient_id = auth.uid()
     and read_at is null;
$$;

revoke all on function public.mark_direct_conversation_read(uuid) from public, anon;
grant execute on function public.mark_direct_conversation_read(uuid) to authenticated;

-- ============ REALTIME ============
-- Guarded so the migration is safe to re-run and on a database without
-- the supabase_realtime publication (e.g. a plain local Postgres).

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'direct_messages'
     ) then
    alter publication supabase_realtime add table public.direct_messages;
  end if;
end $$;

-- ============ VERIFY AFTER APPLYING ============
--   select tablename from pg_publication_tables
--     where pubname = 'supabase_realtime' and tablename = 'direct_messages';
--   a non-friend: get_or_create_direct_conversation() raises
--     'You can only message accepted friends'.
--   calling it twice for the same pair (either direction) returns the
--     same id; direct_conversations has exactly one row.
--   a third user cannot select the conversation or its messages.
--   insert with a spoofed sender_id is rejected by RLS; recipient_id,
--     read_at and created_at cannot be supplied (no column grant).
--   after remove_friend(), insert is rejected; history is still readable.
