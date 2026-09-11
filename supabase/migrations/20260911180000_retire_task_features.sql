-- Vercel and database migrations deploy independently. Retain old columns and
-- normalize legacy writes until every old browser and route has drained.
begin;

-- BEGIN task feature retirement
-- These compatibility guards accept old payloads without restoring features.
-- Keep the old scoring checks and tier_model setting: rejecting a stale write
-- or loading an old planner's defaults during deployment would be worse.
create or replace function public.retire_task_features()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.requires_video := false;
  new.competition_bonus := 0;
  new.winner_team_id := null;
  if new.scoring_mode = 'competition' then
    new.scoring_mode := 'fixed';
  end if;
  -- Historical pairs share a slug; removing their marker breaks uniqueness.
  if tg_op = 'UPDATE' and old.is_secret then
    new.is_secret := true;
  end if;
  if new.is_secret then
    new.active := false;
  end if;
  return new;
end $$;

create or replace trigger retire_task_features
before insert or update on public.tasks
for each row execute function public.retire_task_features();

create or replace function public.retire_submission_features()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.scoring_mode_snapshot = 'competition' then
    new.scoring_mode_snapshot := 'fixed';
  end if;
  new.competition_bonus_snapshot := 0;
  return new;
end $$;

create or replace trigger retire_submission_features
before insert or update on public.submissions
for each row execute function public.retire_submission_features();

-- No rows, identities, evidence, assigned points or quantity counts are removed.
-- Cut rows stay cut, and old secret markers/reveal timestamps remain opaque.
update public.tasks set active = false where is_secret and active;
update public.tasks set requires_video = false, competition_bonus = 0, winner_team_id = null
where requires_video or competition_bonus <> 0 or winner_team_id is not null;
update public.tasks set scoring_mode = 'fixed' where scoring_mode = 'competition';
update public.submissions set competition_bonus_snapshot = 0
where competition_bonus_snapshot <> 0;
update public.submissions set scoring_mode_snapshot = 'fixed' where scoring_mode_snapshot = 'competition';
-- END task feature retirement

-- One latest approved decision per denormalized team/round/task, not per file.
-- Do not filter cut tasks: their already-approved evidence still scores.
-- Fixed/legacy approvals keep their stored award; quantity uses its snapshots.
create or replace view team_scores as
with best as (
  select distinct on (s.round, s.team_id, s.task_id)
         s.round, s.team_id, s.task_id, s.task_points, s.measurement_value, s.points_awarded,
         coalesce(s.scoring_mode_snapshot, t.scoring_mode) as scoring_mode,
         coalesce(s.points_per_unit_snapshot, t.points_per_unit) as points_per_unit
  from submissions s
  join tasks t on t.id = s.task_id
  where s.status = 'approved' and s.points_awarded is not null
  order by s.round, s.team_id, s.task_id,
           s.judged_at desc nulls last, s.created_at desc, s.id desc
),
scored as (
  select *,
    (case when scoring_mode = 'quantity' then
      task_points + coalesce(measurement_value, 0) * points_per_unit
    else points_awarded end)::int as pts
  from best
)
select t.id as team_id, t.round, t.name, t.color, t.sort_order,
       coalesce(sum(s.pts), 0)::int as points,
       count(s.task_id)::int as tasks_scored
from teams t
left join scored s on s.team_id = t.id and s.round = t.round
group by t.id, t.round, t.name, t.color, t.sort_order;

commit;
