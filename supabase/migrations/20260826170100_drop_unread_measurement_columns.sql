-- Drop the measurement columns nothing has ever read.
--
-- measurement_threshold and measurement_cap were added with the first pass at
-- measurable scoring. They have been validated by the admin route, snapshotted
-- onto every submission and named in eight select lists ever since, and
-- effectivePoints has never once looked at either of them.
--
-- Deliberately a SEPARATE migration from
-- 20260826170000_round_end_competition_winner.sql, and pushed after it rather
-- than alongside it. Migrations are applied by a GitHub Action the moment they
-- reach main, while Vercel is still building the matching deploy -- so dropping
-- a column in the same push as the code that stops selecting it leaves the
-- build currently being served asking for a column that no longer exists. Split
-- across two pushes, every version of the app is compatible with every version
-- of the schema it can meet.

begin;

alter table tasks       drop column if exists measurement_threshold;
alter table tasks       drop column if exists measurement_cap;
alter table submissions drop column if exists measurement_threshold_snapshot;
alter table submissions drop column if exists measurement_cap_snapshot;

commit;
