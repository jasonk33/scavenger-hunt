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
  After the relevant validation passes, commit and push directly to `origin/main` when the user
  says to ship; Vercel's Git integration automatically deploys the production build. A feature
  branch is only for an explicit preview or parallel work. Do not run `npx vercel` for normal
  releases; keep it as an emergency fallback if the Git integration is unavailable.

## Architecture

- Next.js App Router + React 19 on Vercel (project `scavenger-hunt`), Supabase Pro. The private
  GitHub repository `jasonk33/scavenger-hunt` is connected to Vercel with `main` as the production
  branch; pushes to other branches create previews. `/go` is the QR target: a re-targetable
  redirect driven by the `fallback_url` setting, so the crowd can be moved without re-printing
  codes.
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

Schema and the `team_scores` view live in `supabase/setup.sql`; incremental changes go in
`supabase/migrate-*.sql`, and are folded back into `setup.sql` as
`alter table ... add column if not exists` so it stays the whole picture.

- **The `task_board` table is the source of truth for task content, points and cuts** — not
  `setup.sql`, which no longer seeds tasks at all. It is edited through the Copilot canvas
  extension in `.github/extensions/scavenger-tasks/`, and reaches players **only** via
  `npm run sync:tasks`. Editing a task in Admin is the field-day escape hatch: it writes
  `tasks` directly, so it is live at once, and **mirrors title, points and `requires_video`
  back onto the board** (`src/lib/board-mirror.mjs`) so the next publish does not silently
  revert it. `is_secret` and `active` are deliberately NOT mirrored -- the board expresses a
  secret as `round: 0` and a hidden task as `status: cut`, and neither is a field copy -- so
  those two still lose to the next publish, and Admin says so on screen. Admin never creates
  a board entry: a task added there has `board_id` null and the planner leaves it alone.
- **`task_board` and `tasks` are two tables on purpose, and must stay that way.** Editing a
  rating changes nothing a player sees until someone publishes; that staging gap is the whole
  design. Queries and validators live in `scripts/board-store.mjs`, shared by the canvas and
  the publisher so they cannot disagree about what a task is.
- **The board used to be `data/task-board.json` and the reasons it is not are load-bearing.**
  A file has one copy per checkout: a worktree edited a board nobody published, two processes
  holding it in memory silently reverted each other, and a publish left a commit stranded on
  whatever branch was checked out. All of that is gone — there is nothing to commit after a
  publish, and no session is the wrong session for task work. Do not reintroduce a file, a
  cache of the board, or a whole-board write. **Writes are per-field on one row**, which is
  what makes two people editing different tasks impossible to get wrong.
- **The canvas polls `/api/board`.** `/events` is served by the extension process and each
  session forks its own, so SSE only ever reaches panels in the same session — it is
  immediacy, not the mechanism. Same reason there are no entry animations on that list as
  everywhere else: a polled list retriggers them every tick.
- **The canvas is project-scoped, so it only loads in a session opened on this repo.** It will
  not appear in a general chat session. Its publish button shells out to the real
  `scripts/task-sync.mjs --json`, so it inherits every refusal rather than reimplementing one —
  **never duplicate planning logic into the canvas.** Its banner must never report a count it
  did not actually measure; `publish-state.mjs` fails towards `unknown` on purpose, and
  `publish-state.test.mjs` exists to keep it that way.
- Board tasks carry a stable `board_id` (`r1-01`, `s-04`) mirrored onto `tasks.board_id`. That
  is the sync key — **never match tasks on their title**, which 8 tasks have already outgrown.
- **Secrets sit at `round: 0` on the board but `tasks.round` is `check (round in (1, 2))`**,
  so each one fans out to one row per round sharing a `board_id`. That is the entire reason
  the board counts 76 tasks and the table holds more; it is not corruption.
- Board `status` is `keep`/`maybe`/`cut`. `cut` means `active = false` — **never a delete**,
  which would cascade to submissions. `maybe` publishes as live and warns, matching the
  extension's own `summarize()`.
- `teams(round, name, color)` — R1 and R2 teams are **separate rows**. `players(name)`.
- `roster(round, player_id, team_id)` — the remix lives here and nowhere else.
- `tasks(round, board_id, title, points, is_secret, revealed_at, active)`. Point tiers
  **1/3/5/7/10**; 7-pointers are the secret challenges, revealed manually from Admin (never
  on a timer). `sort_order` is derived by the sync (tier ascending, secrets last) and is the
  only thing ordering the player's task list.
- `submissions` — one row is **one file**. `status`: `uploading → pending → approved | rejected`.
  Carries `points_awarded`, `reject_reason` (free text the judge types, capped at
  `REASON_MAX`), `note`, `group_id`. There is deliberately no discretionary bonus
  and no award star: a task is approved or rejected, and an approved one is worth
  exactly what the task is worth.
- `settings` is key/value, read via `getSettings()`: `active_round`, `submissions_open`,
  `fallback_url`, `event_name`, `notice`, plus `board_model` (the canvas's tier weights and
  thresholds, as JSON — the board's model, not the app's).
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
  network, no dev server**: the planner and the board's validators are pure, and the board's
  query layer is proved against a fake client in `scripts/board-db.test.mjs`. That is the
  escape hatch — there is one Supabase project and it holds the live event, so a test must
  never be able to reach the real board.
- `npm run ready` — read-only, ~2s, no dev server. Checks *the event* is configured, not that
  the app works, including whether the live task list still matches the board. Run it after
  anything that touches settings.
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
  afternoon can carry. A task is approved or rejected, and an approved one is worth exactly
  what the task is worth. Do not add a way for a judge to type in a number.
- Jason and Anna organize and are **not** players.

## Sharp edges

- `npm run seed` **and** `npm run seed:reset` both delete every submission and every object in
  the bucket. They refuse if submissions exist from anyone outside the guest list in
  `scripts/seed-event.mjs` (`--force` overrides). **Never run either once the party has
  started.** The guest list, `ROUND_1` split and `PAIRS` are arrays at the top of that
  script and are the source of truth — edit there, not in Admin.
  Round 2 is derived by rotation and the script hard-fails if the layout breaks the doc's
  rules (team sizes, split plus-one `PAIRS`, total remix).
  **To change a task, do not use these** — edit the board and run `npm run sync:tasks`,
  which only ever writes to `tasks` and leaves submissions, media, roster and `revealed_at`
  alone. It is dry-run by default; `--apply` publishes.
- **The board is the live database.** Editing it in the canvas is safe mid-event — nothing a
  player sees moves until Publish — but there is no staging copy and no undo. Never drive the
  real board as a test fixture: build a `__qa`-prefixed row, scope every delete to it, and
  hand `scripts/board-store.mjs` a fake client instead (`scripts/board-db.test.mjs`).
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
