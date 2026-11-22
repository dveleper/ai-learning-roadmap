begin;

create table public.learning_progress (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  class_date date not null,
  completed boolean not null default false,
  evaluation smallint check (evaluation between 1 and 5),
  notes text not null default '' check (char_length(notes) <= 10000),
  updated_at timestamptz not null default now(),
  completion_saved boolean not null default false,
  log_saved boolean not null default false,
  primary key (user_id, class_date)
);

alter table public.learning_progress enable row level security;
revoke all on public.learning_progress from public, anon, authenticated;
grant select, insert, update on public.learning_progress to authenticated;

create policy "Read own progress" on public.learning_progress for select
  to authenticated using ((select auth.uid()) = user_id);
create policy "Insert own progress" on public.learning_progress for insert
  to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own progress" on public.learning_progress for update
  to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create function public.save_learning_progress(
  p_class_date date,
  p_completed boolean,
  p_save_log boolean,
  p_evaluation smallint,
  p_notes text,
  p_import boolean
)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.learning_progress as progress
    (class_date, completed, evaluation, notes, completion_saved, log_saved)
  values (
    p_class_date, coalesce(p_completed, false),
    case when p_save_log then p_evaluation end,
    case when p_save_log then p_notes else '' end,
    p_completed is not null, p_save_log
  )
  on conflict (user_id, class_date) do update set
    completed = case when excluded.completion_saved and (not p_import or not progress.completion_saved)
      then excluded.completed else progress.completed end,
    evaluation = case when excluded.log_saved and (not p_import or not progress.log_saved)
      then excluded.evaluation else progress.evaluation end,
    notes = case when excluded.log_saved and (not p_import or not progress.log_saved)
      then excluded.notes else progress.notes end,
    completion_saved = progress.completion_saved or excluded.completion_saved,
    log_saved = progress.log_saved or excluded.log_saved,
    updated_at = now()
  where (excluded.completion_saved and (not p_import or not progress.completion_saved))
     or (excluded.log_saved and (not p_import or not progress.log_saved));
$$;

revoke all on function public.save_learning_progress(date, boolean, boolean, smallint, text, boolean)
  from public, anon, authenticated;
grant execute on function public.save_learning_progress(date, boolean, boolean, smallint, text, boolean)
  to authenticated;

commit;
