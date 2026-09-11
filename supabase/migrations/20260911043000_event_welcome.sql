-- Starting a round and revealing its roster are separate organizer decisions.
-- Do not change existing tasks, teams, submissions, or revealed secrets.
insert into settings (key, value) values ('started_round', '0')
on conflict (key) do nothing;

-- Compare and write under one lock, including legacy setting updates. Ordinary
-- readers and upload finalization remain unblocked during this short transaction.
create or replace function public.transition_event(
  expected_active_round integer,
  expected_started_round integer,
  expected_submissions_open boolean,
  next_active_round integer,
  next_started_round integer,
  next_submissions_open boolean
) returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  current_round integer;
  current_started integer;
  current_open boolean;
begin
  lock table public.settings in share row exclusive mode;

  select
    case when max(value) filter (where key = 'active_round') = '2' then 2 else 1 end,
    coalesce(max(value) filter (where key = 'started_round'), '0')::integer,
    coalesce(max(value) filter (where key = 'submissions_open'), 'true') <> 'false'
  into current_round, current_started, current_open
  from public.settings;
  if current_started = 0 then current_round := 1; end if;
  current_open := current_open and current_started >= current_round;

  if current_round is distinct from expected_active_round
    or current_started is distinct from expected_started_round
    or current_open is distinct from expected_submissions_open then
    return 'stale';
  end if;

  if next_active_round = 2 and current_round = 1
    and exists (select 1 from public.submissions where round = 1 and status = 'uploading') then
    return 'uploading';
  end if;

  if next_active_round not in (1, 2) or next_started_round not in (0, 1, 2)
    or next_active_round is null or next_started_round is null or next_submissions_open is null then
    raise exception 'Invalid event settings';
  end if;

  insert into public.settings (key, value) values
    ('active_round', next_active_round::text),
    ('started_round', next_started_round::text),
    ('submissions_open', next_submissions_open::text)
  on conflict (key) do update set value = excluded.value;
  return 'ok';
end;
$$;

revoke all on function public.transition_event(integer, integer, boolean, integer, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.transition_event(integer, integer, boolean, integer, integer, boolean)
  to service_role;
