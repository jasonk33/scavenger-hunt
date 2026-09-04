<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Scavenger hunt app

A single-use mobile web app for one afternoon in Manhattan: ~24 guests in 5 teams play two
90-minute rounds, teams are **remixed at the break**, and the rounds are scored as two
separate competitions. Players upload photos and clips from their phones against a task
list; two organizers judge live; everyone watches a leaderboard and a feed. Task content is
crude/adult prank humour — do not sanitize it. **The overriding constraint is that it cannot
fail on the day**, and that outranks code cleanliness, tidiness and elegance every time.

`README.md` covers setup, seeding, running the event and fallbacks — read it, don't restate it.

## Project workflow

- This is a personal, single-owner event app. There is no external PR review: do not create pull
  requests or invoke LinkedIn submit/review workflows unless the user explicitly asks for one.
  After the relevant validation passes, commit and push requested code changes directly to
  `origin/main`; do not leave a fix only in the worktree or ask the user to request a push. A
  feature branch is only for an explicit preview or parallel work. Do not run `npx vercel` for
  normal releases; Vercel's Git integration automatically deploys the production build. Keep the
  CLI as an emergency fallback if the Git integration is unavailable.

## Architecture

- Next.js App Router + React 19 on Vercel (project `scavenger-hunt`), Supabase Pro. The private
  GitHub repository `jasonk33/scavenger-hunt` is connected to Vercel with `main` as the production
  branch; pushes to other branches create previews. Share the normal app homepage URL with
  guests; there is no QR-specific redirect route.
- **Media bytes go browser → Supabase Storage directly** over resumable tus
  (`src/lib/upload.ts`), never through a route handler — Vercel caps bodies at 4.5 MB and
  iPhone videos reach 150 MB.
- **Everything else goes through route handlers** in `src/app/api/**` using the service_role
  key. RLS is on with **no table policies**, so the browser cannot read or write tables at
  all. Round, team and point values are resolved server-side; the client only names a task
  and a file.
- **Polling, never WebSockets/Realtime**: 5s on `/submit`, `/judge`, `/leaderboard`; 8s on
  `/feed` and `/admin`; 10s on `/`; 15s for the `Notice` banner. `usePoll`
  (`src/lib/client.ts`) pauses while the tab is hidden and refires on return. Entry
  animations and crossfades on polled lists retrigger every tick — that is why there are none.
- **No Service Worker**, no component/animation/icon libraries, no CSS-in-JS. The visual
  layer is entirely `src/app/globals.css` custom properties plus hand-written classes
  (`.wrap`, `.card`, `.btn`, `.field`, `.pill`, `.row`, `.name`, `.swatch`) plus inline
  `style={{}}`. Keep it that way.

## Domain model

Schema and the `team_scores` view live in `supabase/setup.sql`; every schema change also gets
a timestamped migration in `supabase/migrations/`. The GitHub Action applies pending migration
files to Supabase when they reach `main`. Fold the change back into `setup.sql` as
`alter table ... add column if not exists` so it stays the whole picture. The older
`supabase/migrate-*.sql` files are historical and are not the location for new migrations.

- **Schema changes are code.** Add a timestamped SQL file under `supabase/migrations/`, validate it,
 and push it to `main`; do not ask the user to paste routine schema SQL into the Supabase editor.
 Use the editor only for an explicitly approved emergency or migration-history repair.

- **`tasks` is one table and is edited live.** It is both what players see and where tasks
  are planned. The Copilot canvas in `.github/extensions/scavenger-tasks/` writes these rows
  directly, so a wording change, a re-tier or a cut is in front of players on their next
  poll. Admin's task editor writes the same rows. There is no staging table, no publish step
  and nothing to keep in sync.
- **It used to be two tables and the reasons it is one are load-bearing.** `task_board` held
  content back until `scripts/task-sync.mjs` published it — but Admin already edited `tasks`
  live and mirrored the same four fields back onto the board, so the live path existed
  anyway and the mirror only existed to stop the two disagreeing. Everything the board added
  on top (the ratings, the notes, the props) is never shown to a player, so the gap
  protected nothing. Collapsing it deleted the planner, the title-collision refusal, the
  rename-parking dance, the mirror, the publish banner and an extension that had to find a
  `node` binary and shell out. **Do not reintroduce a staging table, a publish step, a cache
  of the task list, or a whole-list write.** `supabase/migrate-tasks-one-table.sql` is the
  full argument.
- **Writes are per-field, filtered by `slug`.** That is what makes two people editing
  different tasks — or different fields of the same task — impossible to get wrong. Queries
  and validators live in `scripts/task-store.mjs`, shared by the canvas and `npm run ready`
  so they cannot disagree about what a task is.
- **The canvas polls `/api/tasks` on the extension's own loopback server** — not a Next
  route; there is no `src/app/api/tasks`. `/events` is served by that same process and each
  session forks its own, so SSE only ever reaches panels in the same session — it is
  immediacy, not the mechanism. Same reason there are no entry animations on that list as
  everywhere else: a polled list retriggers them every tick.
- **The canvas is project-scoped, so it only loads in a session opened on this repo.** It
  will not appear in a general chat session.
- **`tasks.slug`** (`r1-01`, `s-04`) is the task's stable key, unique per `(round, slug)` and
  `not null` with a uuid default. **Never match tasks on their title**, which 8 tasks have
  already outgrown.
- **A secret is TWO rows sharing one slug.** `tasks.round` is `check (round in (1, 2))`, so a
  challenge offered in both halves cannot be one row. The canvas groups them by slug and
  presents them as `round: 0` — 0 means "both" — and patches by slug so one statement moves
  both rounds. `revealed_at` stays per-row, because revealing in R1 must not spoil R2.
- **Cut means `active = false` — never a delete**, which would cascade to submissions. The
  canvas's In/X toggle writes exactly that column.
- **`round` is moved, not patched.** It is not in `EDITABLE`, so a patch naming it writes
  nothing; the canvas's R1/R2 toggle calls `moveTask`, which renumbers `doc_order` to last in
  the destination and refuses three cases: a secret (two rows, so there is no round to move
  to), an awarded leader bonus, and a task anyone has already submitted — the judge queue,
  `/api/state` and the feed all resolve a submission's task out of the tasks for *that* round,
  so a moved row would show as `(deleted task)`.
- `teams(round, name, color)` — R1 and R2 teams are **separate rows**. `players(name)`.
- `roster(round, player_id, team_id)` — the remix lives here and nowhere else.
- `tasks(round, slug, title, points, scoring_mode, is_secret, revealed_at, active)` plus
  planning-only columns (`doc_title`, `doc_order`, the five ratings, `prop`, `note`,
  `rewrite`, `tier_ok`)
  that no player-facing query selects. Point tiers are **1/3/5/7/10**, but do not infer a
  task's kind from its tier — check the data. The original design made every secret a
  7-pointer; as of the last check every 7-pointer is cut (`active = false`) and the one live
  secret per round is a 5-pointer, so the active tiers are 1/3/5/10. Secrets are revealed
  manually from Admin (never on a timer). **`sort_order` is a generated
  column** — `(is_secret, points, doc_order)` — so nothing maintains it and it cannot drift.
  It is the only thing ordering the player's task list.
- **`scoring_mode` is `fixed` | `quantity` | `competition`**, and it decides what the judge is
  asked for. `fixed` is the default and asks nothing. `quantity` adds
  `points_per_unit` per counted item and is the **only** mode with a number field on the judge
  screen — the count lands in `submissions.measurement_value`. `competition` adds `competition_bonus` to exactly one
  team: `tasks.winner_team_id`, which an **organizer picks from Admin once the round is
  over**. See the scoring invariants below — the end-of-round pick is load-bearing.
- `submissions` — one row is **one file**. `status`: `uploading → pending → approved | rejected`.
  Carries `points_awarded`, `reject_reason` (free text the judge types, capped at
  `REASON_MAX`), `note`, `group_id`. There is deliberately no discretionary bonus
  and no award star: a task is approved or rejected, and an approved one is worth
  exactly what the task is worth.
- `settings` is key/value, read via `getSettings()`: `active_round`, `submissions_open`,
  `event_name`, `notice`, plus `tier_model` (the canvas's tier weights and
  thresholds, as JSON — the planner's model, not the app's).
- **Groups**: several files can be one piece of evidence via `group_id`. It is nullable and
  every read goes through `groupKey()`/`groupBy()` (`src/lib/groups.ts`) — a row without one
  is a group of one. The judge decides a group as a unit. Notes cap at `NOTE_MAX` (280).

**Auth boundary**: the only gate is `ORGANIZER_PIN`, checked by `isOrganizer()` against an
`organizer` cookie whose value **is the PIN verbatim**. It is deliberately not a security
boundary — it stops a player wandering into `/judge`. Unset PIN = wide open. Never build real
auth; there is no cheating threat.

## Load-bearing details — these look like cleanup targets and are not

Validated on real iPhone and Android over 5G (11 uploads, 0 failures, 150 MB in under 30s).

1. `.mov` is relabelled `video/mp4` at upload — `playableType()` in **both** `src/lib/http.ts`
   (server, sets the stored content-type) and `src/lib/upload.ts` (browser). The duplication
   is deliberate. Without it Chrome **downloads** every iPhone video instead of playing it and
   judging stops working.
2. `<video>` needs `preload="auto"` **and** a `#t=0.1` URL fragment, or iOS renders an
   untappable black box instead of a first frame. This is why the feed cannot lazy-load video.
3. The file input must **never** gain a `capture` attribute — players shoot first and upload
   later, and `capture` forces the camera.
4. Inputs stay **≥16px** (`globals.css` uses 17px) or iOS auto-zooms on focus.
5. tus `chunkSize` is exactly `6 * 1024 * 1024` (Supabase requires it) and
   `removeFingerprintOnSuccess: true` — without the latter, re-shooting a task and uploading
   a file with the same name resumes the **old** upload and silently attaches the wrong footage.
6. Storage requires the **legacy `anon` JWT** (starts `eyJ`). `sb_publishable_…` keys are not
   JWTs and fail with `Invalid Compact JWS`. `isJwt()` checks this up front.
7. Every object path carries 8 chars of `randomUUID` (`api/submissions/route.ts`). The
   millisecond stamp alone collided at ~10% in a burst of 30, and `x-upsert: true` means a
   collision silently overwrites another player's media.
8. `isVideoObject()` falls back to the file extension: some Android pickers hand over an empty
   `File.type`, and rendering a video into an `<img>` leaves the judge with no evidence.
9. The `settled` ref in `submit/page.tsx` makes Cancel a no-op once tus has succeeded. Remove
   it and Cancel claims "Nothing was sent" about a submission that IS queued.
10. `SEARCH_AT` in `judge/page.tsx` feeds both a render gate and a filter — they must agree or
    a search outlives the box that clears it.
11. The dark palette in `globals.css` is written **twice** (media query + `[data-theme]`).
    Change both or they diverge.
12. The upload card renders **inside the task row it belongs to** and scrolls itself into view
    (`block: "center"`). It used to render above the search box, so tapping Upload on a task
    far down the list showed the player nothing at all — and the note box lives on that card,
    which is why notes looked like something you could only add after uploading. The
    top-of-page copy is now only the fallback for a task filtered off screen. Its preview is a
    local `URL.createObjectURL`, revoked when the job is replaced; `.media-preview` shortens it
    so the note box stays above the fold.

## Scoring invariants

- `submissions.team_id` and `task_points` are **denormalized at insert**. This is the remix
  defence: joining to the player's *current* roster row would silently rewrite every Round 1
  score at 3:30pm. `npm run smoke` asserts it. Any new column or table must preserve it.
- A task counts **once per team** — the **most recently judged** approval for
  `(round, team_id, task_id)`, enforced in the `team_scores` view. There is deliberately **no
  unique constraint**: two teammates racing the same task must not produce a hard error in
  the field. It used to be the *highest* approval, and that silently ignored the judge when a
  team redid a task whose value had since changed. Rejections are excluded rather than
  counting as "latest", so rejecting a duplicate cannot un-score a task. `/api/state` and the
  export CSV each carry their own copy of this rule and must be changed with the view, or a
  team sees one score on their task list and another on the leaderboard.
- A **competition bonus is an end-of-round decision, never a live race.** It goes to
  `tasks.winner_team_id` — one team, picked by an organizer from Admin — and to nobody until
  that column is set. It used to go to whoever held the highest `measurement_value`,
  recomputed on every read, which meant a team's *already approved* task silently lost points
  when another team was judged, and gave them every reason to go redo it. It also demanded a
  number for tasks like "the worst photo of Jason" that have none, so the judge invented one
  under queue pressure — and every competition task in the event had `competition_bonus = 0`,
  so the number bought nothing. **Do not reintroduce a live leader, and do not put a score
  box back on a competition task.** `supabase/migrations/20260826170000_round_end_competition_winner.sql`
  is the full argument.
- `winner_team_id` is **per row, so per round** when it is picked — like `revealed_at` and
  unlike every other task field, which the Admin PATCH writes by slug. Each half of the event
  is a separate competition between different teams. Clearing it because the task stopped
  being a competition is the exception and writes by slug, following the `scoring_mode` change
  that triggers it. It is also **never snapshotted onto a submission**: it
  is chosen long after those rows were judged, so `points_awarded` holds the baseline and the
  bonus is added on read.

## Verifying work

`npm run dev` first for the first two. **Localhost and production share one Supabase project**
— "testing locally" writes real data. Prefer localhost for destructive exploration.

- `npm run qa` — the one critical Playwright path (`qa/flow2-judge.mjs`): PIN-gated
  judging, approval/rejection and retry, re-review, reassignment, and the leaderboard.
  It is intentionally one driver and normally finishes in seconds. **There is no full
  browser-suite command.**
- For a focused UI change, run exactly one standalone driver with `node qa/<driver>.mjs`.
  Do not chain drivers or recreate a serial runner; no driver may take over one minute.
  Standalone drivers assume **Round 1 is active**.

- `npm run smoke` — API-level suite; self-contained, doesn't import `qa/lib.mjs`.
- `npm test` — `node --test` over `scripts/*.test.mjs` and the canvas's own tests. **No DB, no
  network, no dev server**: the task validators are pure, and the query layer is proved
  against a fake client in `scripts/task-db.test.mjs`. That is the escape hatch — there is
  one Supabase project and it holds the live event, so a test must never be able to reach
  the real tasks. `scripts/portable.test.mjs` proves the canvas still imports in a checkout
  with no `node_modules`; nothing in its import graph may require a package.
- `npm run ready` — read-only, ~2s, no dev server. Checks *the event* is configured, not that
  the app works. Run it after anything that touches settings.
- `npm run build`, `npx tsc --noEmit`, `npx eslint src scripts qa .github/extensions --max-warnings=0`.

**Playwright screenshots in `qa/shots/` (gitignored) are readable with the `view` tool** and
have caught bugs no assertion would. `shot()` is `fullPage: false`. Playwright Chromium is
*not* iOS Safari — anything touching `<video>`, the file picker or input zoom still needs a
real device.

### Harness rules

- `qa/lib.mjs` **refuses to run at import time** while any real submission is `pending`/
  `uploading`, because drivers act on the front of the oldest-first queue and a real
  submission sits ahead of every fixture. It has already approved one of Jason's real
  submissions once. Judge or clear them first; `--allow-real-data` overrides.
- Every driver creates `__qa`-prefixed fixtures, restores settings in a `finally`, and diffs
  `snapshot()`. A run is not clean unless it prints `real data intact: true`.
- Never filter with SQL `LIKE` on `__qa` — `_` is a single-char wildcard. Use `isQa()`.
- Scope every cleanup delete by the driver's own ids. Deleting a team cascades to its roster rows.
- **An assertion that can't fail is worthless.** Prove a new one fails against the unfixed code
  before trusting it — a truncation probe once asserted a "readable floor" and passed a build
  that showed a real phone `Alex Riv…`.

## Settled — do not relitigate

- No security model, no moderation, no rate limiting, no real auth.
- No new runtime dependencies. A small plain component in `src/components/` is the ceiling for
  shared UI. Complexity budget is near zero; prefer deleting over adding.
- No video length or size cap and no photo/video split — one uniform pipeline. Explicitly
  rejected. Nothing enforces the planning doc's "clips under 15 seconds".
- No transcoding and no HEIC/HEVC handling: iOS transcodes on upload, so every device in the
  fleet delivers H.264/AAC and JPEG.
- **No discretionary points and no award flag.** A 0–2 "creativity" bonus and a starred
  award-candidate shortlist both existed and were both removed as more complexity than the
  afternoon can carry. A judge approves or rejects; they never choose *how much* something is
  worth. The one number they type is the `quantity` count — an objective tally of what is in
  the photo, at a rate the task fixed in advance — and the `competition` winner is a separate
  decision made calmly after the round, not a score entered under queue pressure.
- **Saved tasks are localStorage, not a table.** Not to be confused with the removed award
  star above — this one is player-side, private, and touches no score. The ☆ on each task
  card and the "Saved" filter on `/submit` are a triage note for a guest facing a task list
  far longer than 90 minutes allows, written to `sh.saved.<playerId>` by `getSaved`/
  `setSaved` in `src/lib/client.ts`. Keyed by player id because a phone can change hands.
  Do not migrate this to the database: it would add a migration, a route and 5s of poll
  latency to a tap, and buy nothing the afternoon needs. Two details are load-bearing:
  `toggleSaved` **re-reads storage at the moment of the tap** rather than trusting the set
  the render closed over, because a second tab holds its own snapshot and a whole-set write
  would silently destroy its stars; and the count is computed against the live task list, so
  ids left by the remix or by a cut task never inflate it.
- **The one thing the server knows about a star is that they should all go.** A reset deletes
  every submission, which makes a shortlist of tasks the team already "did" worse than no
  shortlist — but the stars are on 24 phones and no route can reach them. So the reset bumps
  `settings.saved_epoch`, `/api/state` hands it to every device, and `syncSavedEpoch`
  (`src/lib/client.ts`) sweeps `sh.saved.*` the first time it sees a value it has not seen.
  This is a **signal, not a store** — it does not make the database the home of the stars, and
  it is not licence to put them there. Three details are load-bearing: a device with **no**
  stored marker adopts the current one *without* clearing (otherwise shipping this would have
  wiped every existing shortlist on the next poll); the marker lives under `sh.savedEpoch`,
  deliberately **outside** the `sh.saved.` prefix the sweep deletes, or each poll would clear
  again and delete stars a second after they were tapped; and it must arrive on a **poll**, not
  a reload, because a phone in a pocket must not come back to a shortlist of work that no
  longer exists.
- Jason and Anna organize and are **not** players.

## The room — facts about the day, not inferences to re-derive

Task content only makes sense against these. They are not visible in the schema, so an agent
that reasons from the data alone will invent a different party and give confident advice about
it. **Every one of these has already been guessed wrong.**

- **Everyone already knows everyone.** ~24 adult friends at Jason's birthday, not colleagues
  and not strangers. There is no ice to break and no rapport curve: a task is not "harder in
  Round 1 because they only just met."
- **The remix destroys teammate continuity, it does not build it.** Round 2 puts a player with
  different people, so nothing about a task's social cost can be justified by time spent with
  *that* team. Round 1 and Round 2 differ by the clock and the drinking, and not much else.
- **Round order is thematic and weak.** Do not propose wholesale re-arrangements of tasks
  between rounds on a "warm-up then escalate" theory. It has been tried and rejected.
- **Jason buys and packs the props himself**, into a goodie bag per round. An empty `prop`
  field is bookkeeping, not a missing item, and "you forgot to buy X" is not a finding.
  What *is* worth reporting: a prop needed in **both** rounds (it has to go in both bags), or
  a task whose wording assumes a prop the `prop` column never declares — `r2-14` lost "made
  from something off the street" to a rewrite and quietly started demanding rings.
  **The fix for that is to ask and then declare the prop, never to reword the need away.**
  Rewording it away has already been tried once and was wrong: Jason had bought fake
  engagement rings, so `r2-14` asks for a real one and now names them in `prop`.

**The rule this exists to enforce: do not infer a fact about the guests, the venue, the day,
or how a field behaves — check it, or ask.** Repeated failures in one session came from
asserting plausible-sounding facts and building on them, and the cost lands on whoever reads
the confident wrong answer.

## Field semantics that get assumed wrong

- **`measurement_label` is ONE unit, singular and lower case** — `extra pigeon`, not
  `Number of extra pigeons`. Both screens read it as the tail of a sentence: the player's pill
  says `+1 pt per extra pigeon` and the judge's count box is headed with a bare `How many?`
  and that same rate line underneath. A plural or a `Number of…` phrase renders as
  `+1 pt per Number of extra pigeons`, which is what it used to say. It follows that **the
  title must not repeat the rate** — three of them carried a `(+1 point for each additional
  pigeon)` that said the pill's job twice.
- **`measurement_label` is `quantity`-only.** `judge/page.tsx` gates it behind
  `scoringMode === "quantity"`. The Admin "Leader bonuses" picker renders the **title**, the
  bonus and a team dropdown — never the label. So on a `competition` task the label is dead data, and **the winner criterion has
  nowhere to live but the title.** Setting the label instead accomplishes nothing.
- **A group's score is looked up by `groupKey`, never by row id.** Several files sent
  as one piece of evidence are one decision, but only ONE row inside the group scores — the
  newest, per `latestApproved` — while every screen anchors its group on the OLDEST file.
  Keyed by row id the lookup misses on every multi-file group and falls through to
  `awardedBreakdown()`, which reads what was frozen at judging time and therefore cannot
  know about a competition bonus decided afterwards. `/api/feed`, `/api/state`,
  `/api/task-entries` and `/api/leaderboard/[teamId]` all carry this rule, and any query
  feeding it must select `group_id` or `groupKey` silently degrades to the row id and
  reintroduces the bug. `winningGroups` takes RAW rows for the same reason: handed ranked
  ones it can only ever return single-file groups. `flow6` section 7 is the guard — a
  competition task with a decided winner and two files is the only shape where the ranked
  path and the frozen fallback differ.
- **A score renders as two pills, never one total** — `<Score>` (`src/components/Score.tsx`):
  what the task was worth, then `+N bonus` when the team earned more. `12 pts` hid the fact
  that anyone had gone beyond the task. Both numbers come from `pointsBreakdown()` server-side
  so no screen subtracts a baseline it fetched separately; `awardedBreakdown()` covers a row
  `scoreApproved` did not rank. **The wrapper must not carry `min-width: 0`** — the pills
  inside are `nowrap`, so a shrinkable wrapper lets them overflow the row rather than wrap.
  `probe-truncation` measures both the feed header and the judge's judged-list row for this.

## Sharp edges

- `npm run seed` **and** `npm run seed:reset` both delete every submission and its linked
  media (not orphaned bucket objects), re-hide secrets and reopen Round 1.
  They refuse if submissions exist from anyone outside the initial guest list in
  `scripts/seed-event.mjs` (`--force` overrides). **Never run either once the party has
  started.** The guest list, `ROUND_1` split and `PAIRS` arrays are initial bootstrap
  data, not the live roster. **Use Canvas → Roster for ongoing RSVPs and assignments;
  never re-seed to apply them.** The seed's initial Round 2 is derived by rotation and
  checked for team sizes, split plus-one pairs and a total remix; it is not the current plan.
  **These do not change task content, but they do reset `revealed_at`.**
  Changing a task is a canvas or Admin edit, and
  neither can take submissions, media, roster or `revealed_at` with it.
- **`/api/admin/reset` is the other destructive path** — Admin → health → "Reset submissions".
  It deletes every submission, the media each one uploaded and every awarded `winner_team_id`,
  bumps `saved_epoch` so every phone drops its starred shortlist, and it is the one thing in
  the app with no undo. It sweeps the submissions and not the bucket, so bytes orphaned by a
  cancelled upload survive on purpose. Three guards, and none is
  redundant: the PIN, the `ALLOW_RESET` env switch (unset in Vercel for the event, which both
  hides the card and makes the route 403), and a typed confirm word that a stray request cannot
  supply. It deliberately stops at submissions — players, teams, roster, tasks and `revealed_at`
  all survive, so it costs a re-upload rather than a re-seed. **`npm run smoke` covers only its
  refusals**, and that is not an oversight to correct: this Supabase project holds the live
  event, so a test that proved the happy path would have to delete Jason's real photos to do
  it. Each refusal assertion re-reads a submission afterwards, so a route that reset anyway
  fails loudly. For the same reason **no probe may send the real confirm word** — `isOrganizer()`
  is true when `ORGANIZER_PIN` is unset, so a "this should 401" request carrying a valid payload
  would wipe the project it was meant to prove safe.
- **The canvas edits the live database, with no undo.** Safe mid-event in the sense that it
  cannot destroy anything — a cut is `active = false` and scores stand — but a keystroke in
  the title field is in front of players seconds later. Never drive the real tasks as a test
  fixture: build a `__qa`-prefixed row, scope every delete to it, and hand
  `scripts/task-store.mjs` a fake client instead (`scripts/task-db.test.mjs`).
- The `notice` banner is sticky and eats viewport. If you set one for testing, clear it.
- `api()` in `src/lib/client.ts` has **no timeout**. A request that hangs forever leaves
  Upload buttons disabled with Cancel a no-op.
- `/api/feed` clamps to `limit=400` (max 500) and renders video with `preload="auto"`, so a
  feed open eagerly fetches every clip on the page. A cost question, not a correctness one.
- Two recurring bug classes, both of which have produced every serious bug so far:
  **a screen asserting a result during its pre-load window** (`qa/probe-loading.mjs` holds each
  data endpoint open and asserts screens never claim a result they don't have — don't weaken
  it), and **a control that hides itself while its state persists**, stranding the user.
- Names are organizer-typed and must **never** truncate — `.name`/`.pill-wrap` in `globals.css`
  carry the rule and `qa/probe-truncation.mjs` asserts zero clipping down to 260px. Adding a
  new place a name or reject reason renders means adding it to that probe's `SCREENS`.
- `origin` is a **personal** repo (`jasonk33`), but agent shells are injected with a `GH_TOKEN`
  and a `GIT_CONFIG_PARAMETERS` credential helper for an unrelated work account, which cannot
  see it — the push fails as `Repository not found`, never as a permission error. From an agent
  shell, push with `env -u GIT_CONFIG_PARAMETERS GH_TOKEN= git push`, and prefix `gh` with
  `GH_TOKEN=`. A normal terminal is unaffected.
