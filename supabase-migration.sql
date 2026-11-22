create table public.runs (
  id uuid primary key default gen_random_uuid(),
  player uuid not null,
  season text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'active' check (status in ('active','submitted','rejected','abandoned')),
  score int,
  served int,
  reason text
);
create index runs_player_idx on public.runs (player, started_at desc);
create index runs_status_idx on public.runs (status, started_at);

create table public.scores (
  season text not null,
  player uuid not null,
  name text not null check (char_length(name) between 1 and 10),
  score int not null check (score >= 0),
  served int not null default 0,
  run_id uuid not null unique references public.runs(id),
  updated_at timestamptz not null default now(),
  primary key (season, player)
);
create index scores_board_idx on public.scores (season, score desc, updated_at);

alter table public.runs enable row level security;
alter table public.scores enable row level security;
-- leaderboard is public read-only; every write goes through the edge function (service role)
create policy "scores are readable by everyone" on public.scores for select to anon, authenticated using (true);
revoke insert, update, delete on public.scores from anon, authenticated;
revoke all on public.runs from anon, authenticated;

alter publication supabase_realtime add table public.scores;
