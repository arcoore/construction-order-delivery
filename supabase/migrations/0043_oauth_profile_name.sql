-- OAuth-ready display name for the profiles auto-create trigger.
--
-- handle_new_user() (0002) set profiles.display_name from
-- raw_user_meta_data ->> 'display_name', which the email sign-up form always
-- supplies. A social sign-in (Google / Microsoft / Apple) never sets that
-- key - the provider sends 'full_name' or 'name' - so every OAuth user would
-- otherwise land as "New user". Widen the fallback chain; email sign-up is
-- unchanged (display_name still wins). display_name stays cosmetic-only -
-- nothing anywhere branches on it (see 0002's header).
--
-- create or replace updates the function the existing on_auth_user_created
-- trigger already calls; the trigger itself is untouched.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'New user'
    )
  );
  return new;
end;
$$;
