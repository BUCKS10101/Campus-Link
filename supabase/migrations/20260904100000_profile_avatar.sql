-- Profile avatar: editable photo on /profile - see chat request
-- (2026-08-28). Additive only: one new nullable column, one new storage
-- bucket, four new storage.objects policies scoped to that bucket. No
-- existing table, column, policy, or grant is touched.
--
-- Path convention: every avatar is stored at `${auth.uid()}/avatar.<ext>`
-- - a fixed filename per user (not a new file per upload), so re-uploading
-- overwrites the previous photo (via upsert on the client) instead of
-- accumulating orphaned files with no cleanup mechanism. The folder-prefix
-- ownership check below is what makes this safe: nobody can write into
-- another user's folder regardless of filename.
--
-- Bucket is public (readable by anyone with the URL, no signed-url
-- machinery) - a profile photo is not sensitive data, and every other
-- profile-adjacent field already visible to order/friend counterparties
-- (name, hostel block) is equally unauthenticated-readable-if-you-have-
-- the-link in spirit. Writes remain strictly owner-only via RLS below.

alter table profiles add column if not exists avatar_url text;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

drop policy if exists "avatars_select_all" on storage.objects;
create policy "avatars_select_all"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects for insert
  with check (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects for update
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects for delete
  using (bucket_id = 'avatars' and auth.uid()::text = (storage.foldername(name))[1]);

-- ============ VERIFY AFTER APPLYING ============
-- Manual checks:
--   profiles.avatar_url exists, nullable, no default - every existing row
--     is unaffected (reads as null until a user uploads a photo).
--   A user can upload to <their own uid>/avatar.<ext> and it succeeds.
--   A user CANNOT upload/overwrite/delete a file under a different uid's
--     folder - direct API attempt should fail via RLS.
--   The public URL for an uploaded object is fetchable without auth
--     (bucket is public).
