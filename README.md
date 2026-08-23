# Scavenger hunt app

Mobile web app for the birthday scavenger hunt. Players submit photos and video
from their phones, organizers judge and score live, everyone sees a leaderboard
and a feed.

No app install, no accounts, no passwords for players.

---

## Setup (about 15 minutes, once)

### 1. Supabase

Open the SQL editor in your Supabase project, paste in the whole of
`supabase/setup.sql`, and run it. That one file creates the tables and the
scoring view, turns on RLS, makes the `hunt` bucket with a 500 MB limit and the
right upload policies, and seeds 5 teams per round.

It does **not** seed tasks. The task list lives on the planning board in the
`task_board` table and is published by `npm run sync:tasks` (see below), so
there is only ever one copy of it. Every statement in `setup.sql` is idempotent,
but after a change that touches the schema you only need the matching file in
`supabase/` — each is a small, re-runnable set of `ALTER`s carrying no seed data:

- `supabase/migrate-groups-and-notes.sql` — several files per submission, and
  player-written notes.
- `supabase/migrate-task-board-id.sql` — links each task row back to its entry on
  the planning board. Run this once before the first `npm run sync:tasks`.
- `supabase/migrate-task-board.sql` — the planning board itself. Run this once
  before opening the canvas.
- `supabase/migrate-drop-bonus-star.sql` — removes the creativity bonus and the
  award star, and makes the judge's most recent approval the one that scores.
  Deploy the app first, then run this: the old code writes those columns on
  every approval.

Then get your keys from **Settings → API Keys → the "Legacy anon, service_role
API keys" tab**.

Use the **legacy** keys, the ones starting with `eyJ`. The newer
`sb_publishable_…` keys do **not** work with Storage: it requires a JWT and
rejects them with `Invalid Compact JWS`. This was verified the hard way.

Stay on the **Pro** plan through the event. Free projects pause after a week idle.

### 2. Local config

```bash
cp .env.example .env.local
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY, ORGANIZER_PIN
npm install
npm run dev
```

### 3. Load the event data

```bash
npm run seed          # guest list, teams for both rounds, tasks from the board
npm run seed:reset    # remove them again
```

The guest list and the team split live at the top of `scripts/seed-event.mjs`.
Edit them there and re-run as people RSVP, rather than clicking through Admin.

Both commands delete **every submission and every media file** in the project,
so they refuse to run once anyone outside that guest list has submitted
something. Use `seed:reset` to clear your own testing before the day.

### 4. Publish the task list

```bash
npm run sync:tasks            # show what would change, write nothing
npm run sync:tasks -- --apply # publish it
npm run sync:tasks -- --json  # the same run as one JSON object, for the canvas
```

Tasks are edited on the planning board — titles, point tiers, which need a clip,
and which are cut — through the Tasks tab of the Copilot canvas in
`.github/extensions/scavenger-tasks/`. The same canvas's Roster tab edits people,
paired team names and Round 1/2 assignments live. The board is the `task_board`
table, and `sync:tasks` is the only thing that carries task edits to players.
Roster assignments apply on selection; person names and team names/colours auto-save
to the live tables.

The canvas has a banner showing how many board edits are not yet live and a
button that publishes them, which just runs the command above — so it refuses
for exactly the same reasons, and says why. If it cannot work out the count, it
says so; it never reports zero for a check that failed.

Because the board is a table rather than a file in a checkout, it does not
matter which session you edit it from: a worktree, a branch, any git branch. The
canvas polls, so a change made in one session shows up in another, and Publish
is the whole job — there is nothing to commit afterwards.

Because the extension lives in `.github/extensions/`, it is **only available in
a session opened on this repo** — it will not appear in a general chat session.
That is deliberate: publishing needs this repo's `.env.local` anyway.

Unlike `seed`, task publishing is safe during the event: it writes to the `tasks`
table and nothing else, so submissions, media, the roster and any revealed secrets
are untouched. A task cut on the board is hidden (`active = false`), never deleted,
so points already awarded against it still stand and anything already in the
judge's queue can still be decided.

`npm run ready` tells you if the board and the live app have drifted apart.

### 5. Verify it actually works

```bash
npm run smoke     # with the dev server running in another terminal
```

This does a real TUS upload to Storage, judges it, and checks the score — the
whole path a phone takes. It also asserts that remixing the roster doesn't move
Round 1 scores, which is the one bug in this app that would be both silent and
unrecoverable.

It creates and tears down its own throwaway teams and player, so it is safe to
run against a project that already has real data. By default it refuses to run
against anything but localhost, because it briefly switches rounds and closes
submissions; `npm run smoke -- --allow-prod` overrides that once the event is
not running.

```bash
npm run qa            # also with the dev server running; one critical browser path
```

`qa` drives one critical browser path through Playwright: PIN-gated judging, approval,
rejection and retry, re-review, reassignment, and the leaderboard. It is intentionally a
single driver and normally finishes in seconds; there is no full browser-suite command.
`smoke` proves the API is right; `qa` proves the screens are.

For a focused UI change, run exactly one standalone driver with `node qa/<driver>.mjs`;
do not chain drivers or recreate a serial runner. No driver may take over one minute.
The standalone drivers need Round 1 active.

On a fresh clone, download the browser binary once first:

```bash
npx playwright install chromium
```

Each driver creates its own `__qa`-prefixed fixtures, restores every setting in a
`finally`, and then diffs a snapshot of the real event data — including which
secret challenges are revealed — so a run that quietly changes your event fails
instead of passing.

```bash
npm run ready     # no dev server needed
```

`ready` is the one to run on the morning of. It doesn't test the app — it checks
that *your event* is set up: submissions open, no stale banner, every player on a
team, secret challenges still hidden, no test fixtures left behind, upload key
valid. A crashed test run once left submissions closed, and nothing about the app
looks broken in that state — every player just sees "Submissions are closed" and
assumes it's them.

Open **Admin → health** for the same checks from the browser.

### 6. Deploy

The repository is connected to the Vercel project `scavenger-hunt`. Normal
deployments are automatic:

1. Run the relevant checks locally.
2. Commit the change.
3. Push `main`:

   ```bash
   git push origin main
   ```

Vercel creates a production deployment for each push to `main` and preview
deployments for other branches and pull requests. Do not run `npx vercel` for
normal releases. If the Git integration is unavailable during an emergency,
`npx vercel --prod` remains a manual fallback.

Set the same four environment variables in the Vercel project settings.
Changing them requires a new deployment; use Vercel's redeploy action or push
a follow-up commit.

---

## Running the event

**Before the day**

1. Admin → Roster → paste the guest list, one name per line.
2. Assign everyone to a Round 1 team. Assign Round 2 too, or use
   *Copy from Round 1* and adjust at the break.
3. Admin → health. Everything green.
4. Share the app's normal homepage URL in the group text.

**Round 1 (1:00–2:30)**

- Players open the link, tap their name once, and upload against tasks.
- You sit in Judge. One tap approves at the task's value — that is the whole
  decision, there is nothing to top up or flag. Rejecting asks why: tap one of
  the four common reasons or type your own, and the team reads it and redoes it.
- If a team redoes a task and you approve the new attempt, that ruling is the
  one that counts, even if the task was worth more the first time.

**The break (2:30–3:30)**

1. Admin → Event → close submissions. Let the queue drain.
2. Admin → Roster → Round 2 → make the swaps.
3. Admin → Event → active round = 2, reopen submissions.

Nobody re-scans or re-joins anything. Round 1 scores cannot move: every
submission stored its team when it was created.

**Secret challenges**

Admin → Tasks → Reveal. Manual, not on a timer — the timer would fire while the
round is running late.

---

## If something goes wrong

Ranked by how likely you are to need them.

1. **The banner.** Admin → Event → Banner appears on every screen within 15
   seconds. This handles most "something is weird" moments without touching code.
2. **Text the organizer.** Announce a phone number at the start. If a player's
   upload fails, the photo is still on their phone; they text it and you enter it
   later. No integration, nothing to break.

---

## How it's built

- **Next.js on Vercel + Supabase Pro.**
- **Media goes browser → Supabase Storage directly** over resumable TUS uploads.
  It never passes through a serverless function: Vercel caps request bodies at
  4.5 MB and iPhone videos run to 150 MB.
- **Everything else goes through route handlers** using the service_role key. RLS
  is on with no policies, so the browser can't touch the tables. Round, team and
  point values are always resolved server-side — the client only names a task and
  a file.
- **Polling every 5 seconds**, not WebSockets. A poll can't get stuck in a bad
  state; the next tick fixes it. There is no reconnect logic to get wrong.
- **No Service Worker.** A stale worker serving an old bundle mid-event is worse
  than being offline-incapable.

### Measured, not assumed

Validated on real iPhone and Android hardware over 5G in Manhattan — 11 uploads,
0 failures:

| Device | File | Size | Time |
|---|---|---|---|
| iPhone | 4K30 video, 30s | 90 MB | 15.4s |
| iPhone | 1080p video, 77s | 150 MB | 17.3s |
| Android | video | 13.4 MB | 1.9s |

iOS transcodes on upload: video shot in High Efficiency arrives as H.264/AAC and
photos always arrive as JPEG. So there are no camera settings to tell guests
about, no HEIC/HEVC risk, and no transcoding service in the stack.

`../TEST-RESULTS.md` has the full detail.

### Things that look like cleanup but are not

- `.mov` is relabelled `video/mp4` at upload. Without it Chrome **downloads**
  every iPhone video instead of playing it, and judging stops working.
- `chunkSize` is exactly 6 MB. Supabase's docs say do not change it.
- `removeFingerprintOnSuccess: true`. Without it, re-shooting a task and
  uploading a file with the same name resumes the *old* upload and silently
  attaches the wrong footage.
- `<video preload="auto" src="...#t=0.1">`. Without the fragment, iOS shows an
  untappable black box instead of a first frame.
- The file input has no `capture` attribute, so players can pick clips they
  already shot.
- `team_id` and `task_points` are denormalized onto each submission. This is what
  makes the roster remix safe.
