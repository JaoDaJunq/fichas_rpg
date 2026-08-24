-- Fichas Daemon v11: Biblioteca + histórico/undo

create table if not exists public.room_library (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null check (char_length(trim(title)) between 1 and 120),
  category text not null default 'Pista' check (char_length(category) between 1 and 40),
  body text not null default '',
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists room_library_room_id_idx
on public.room_library(room_id, created_at desc);

drop trigger if exists set_room_library_updated_at on public.room_library;
create trigger set_room_library_updated_at
before update on public.room_library
for each row execute function public.set_updated_at();

alter table public.room_library enable row level security;

drop policy if exists "room library visible to members" on public.room_library;
create policy "room library visible to members"
on public.room_library
for select
to authenticated
using (
  public.is_room_master(room_id)
  or (is_public and public.is_room_member(room_id))
);

drop policy if exists "masters insert room library" on public.room_library;
create policy "masters insert room library"
on public.room_library
for insert
to authenticated
with check (
  public.is_room_master(room_id)
  and created_by = auth.uid()
);

drop policy if exists "masters update room library" on public.room_library;
create policy "masters update room library"
on public.room_library
for update
to authenticated
using (public.is_room_master(room_id))
with check (public.is_room_master(room_id));

drop policy if exists "masters delete room library" on public.room_library;
create policy "masters delete room library"
on public.room_library
for delete
to authenticated
using (public.is_room_master(room_id));

grant select, insert, update, delete on public.room_library to authenticated;

create table if not exists public.character_history (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null default 'sheet_update',
  summary text not null default 'Alteração na ficha',
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists character_history_room_id_idx
on public.character_history(room_id, created_at desc);

create index if not exists character_history_character_id_idx
on public.character_history(character_id, created_at desc);

alter table public.character_history enable row level security;

drop policy if exists "masters read character history" on public.character_history;
create policy "masters read character history"
on public.character_history
for select
to authenticated
using (public.is_room_master(room_id));

drop policy if exists "masters insert character history" on public.character_history;
create policy "masters insert character history"
on public.character_history
for insert
to authenticated
with check (
  public.is_room_master(room_id)
  and actor_id = auth.uid()
);

drop policy if exists "masters update character history" on public.character_history;
create policy "masters update character history"
on public.character_history
for update
to authenticated
using (public.is_room_master(room_id))
with check (public.is_room_master(room_id));

grant select, insert, update on public.character_history to authenticated;
grant usage, select on sequence public.character_history_id_seq to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'room_library'
  ) then
    execute 'alter publication supabase_realtime add table public.room_library';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'character_history'
  ) then
    execute 'alter publication supabase_realtime add table public.character_history';
  end if;
end $$;
