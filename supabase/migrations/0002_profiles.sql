-- Profiles: the one-to-one presentation-data companion to auth.users.
--
-- auth.users.id (a real Supabase Auth UUID, driven by auth.uid() in every
-- policy and function from here on) is the ONLY identity that ever matters
-- for permission decisions. display_name is purely cosmetic — mirrors the
-- prototype's identity.js principle exactly: duplicate display names must
-- stay completely safe, because nothing ever branches on them.

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

-- A profile row is created automatically the moment a real auth.users row
-- exists — the client never inserts into profiles directly (see RLS in
-- 0009: no INSERT policy is granted to the authenticated role at all).
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', 'New user'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
