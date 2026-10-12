-- Open sign-up to any valid email address.
--
-- 20260903170000_enforce_vit_email_domain.sql rejected every sign-up whose
-- email was not @vitstudent.ac.in, at the database level (a BEFORE INSERT
-- trigger on auth.users). The product decision is now to let anyone with a
-- valid email register, so the domain check is removed.
--
-- The trigger itself stays, and the function keeps its fail-safe: a null,
-- empty or structurally invalid email is still rejected, so nothing here
-- widens what Supabase Auth already requires. Email ownership is still
-- proved by the "Confirm email" setting, and the verified-email gate on
-- posting, accepting, messaging and friend requests
-- (20260903180000_email_verification_enforcement.sql) is unchanged.
--
-- Only affects NEW sign-ups. No existing row is touched.
--
-- ROLLBACK (restore the VIT-only rule): recreate enforce_vit_email_domain()
-- with the domain check from 20260903170000_enforce_vit_email_domain.sql.

create or replace function public.enforce_vit_email_domain()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Administrative/system inserts (Dashboard "Add user", service_role) are
  -- exempt, exactly as before.
  if current_setting('role', true) = 'service_role' then
    return new;
  end if;

  if new.email is null or btrim(new.email) = '' then
    raise exception 'A valid email address is required'
      using errcode = 'check_violation';
  end if;

  -- Any single local part, an @, and a dotted domain. Deliberately loose:
  -- real validation is deliverability, proved by email confirmation.
  if new.email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'A valid email address is required'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- ============ VERIFY AFTER APPLYING ============
--   signUp with anyone@gmail.com succeeds (then needs confirmation if
--     "Confirm email" is on).
--   signUp with "not-an-email", "a@b" or "" is still rejected.
--   an @vitstudent.ac.in sign-up still works unchanged.
