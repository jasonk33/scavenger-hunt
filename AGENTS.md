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

## Architecture

- Next.js App Router + React 19 on Vercel (project `scavenger-hunt`), Supabase Pro. Git repo on
  `main`, backed up to the private `jasonk33/scavenger-hunt`. `/go` is the QR target: a
  re-targetable redirect driven by the `fallback_url` setting, so the crowd can be moved
  without re-printing codes.
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

- **`data/task-board.json` is the source of truth for task content, points and cuts** — not
  `setup.sql`, which no longer seeds tasks at all. It is edited through the Copilot canvas
  extension in `.github/extensions/scavenger-tasks/` (`store.mjs` holds the schema and
  validators, and resolves the board relative to itself), and reaches players **only** via
  `npm run sync:tasks`. Nothing else writes task rows. Editing a title in Admin is a
  field-day escape hatch; the next sync will put the board's wording back.
- **The canvas is project-scoped, so it only loads in a session opened on this repo.** It will
  not appear in a general chat session. Its publish button shells out to the real
  `scripts/task-sync.mjs --json`, so it inherits every refusal rather than reimplementing one —
  **never duplicate planning logic into the canvas.** Its banner must never report a count it
  did not actually measure; `publish-state.mjs` fails towards `unknown` on purpose, and
  `publish-state.test.mjs` exists to keep it that way.
- **Commit a board edit on its own.** The canvas writes the file the moment the user changes a
  rating, so a session doing code work will find it already dirty through no action of its own.
  Never let `git add -A` fold it into an unrelated commit: what changed on the board, and when,
  is the event's own history.
- **Task work belongs in a branch session, not a worktree.** Both the canvas and `sync:tasks`
  resolve the board relative to themselves, so in a worktree they agree — on that worktree's
  stale committed copy, while the one shared Supabase project is behind all of them. Publishing
  there reverts live tasks; editing there produces board changes nobody publishes. `sync:tasks`
  refuses — `git rev-parse --git-dir` vs `--git-common-dir` — and the canvas surfaces that same
  refusal in its banner. Override with `TASK_SYNC_ALLOW_WORKTREE=1`.
- Board tasks carry a stable `id` (`r1-01`, `s-04`) mirrored onto `tasks.board_id`. That is
  the sync key — **never match tasks on their title**, which 8 tasks have already outgrown.
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
  Carries `points_awarded`, `bonus` (0–2 discretionary), `starred` (award candidate),
  `reject_reason`, `note`, `group_id`.
- `settings` is key/value, read via `getSettings()`: `active_round`, `submissions_open`,
  `fallback_url`, `event_name`, `notice`.
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
- A task counts **once per team** — best approved `(round, team_id, task_id)`, enforced in the
  `team_scores` view. There is deliberately **no unique constraint**: two teammates racing the
  same task must not produce a hard error in the field.

## Verifying work

`npm run dev` first for the first two. **Localhost and production share one Supabase project**
— "testing locally" writes real data. Prefer localhost for destructive exploration.

- `npm run qa` — 17 Playwright drivers in `qa/` driving the real UI. ~6 min, strictly
  serial. **Run only the driver(s) covering what you changed**, not the suite: `npm run qa
  -- judge` runs every driver whose filename matches (`node qa/flow2-judge.mjs` also works
  and is identical). The whole suite is for before a PR, and before the event.
  Every driver assumes **Round 1 is active** — the fixtures are rostered into round 1, so
  the suite fails wholesale while `active_round` is 2.

  | driver | covers | ~ |
  |---|---|---|
  | `flow1-upload` | `/` join → identity, `/submit` upload via the real file chooser, progress card, mid-flight Cancel, `.mov` relabel, offline failure copy, no phantom `uploading` rows | 15s |
  | `flow2-judge` | `/judge` PIN gate, approve with bonus + star, controls resetting between items, reject reasons, the player's rejection banner and Retry, re-review, Undo, reassignment, `/leaderboard` | 12s |
  | `flow3-roundflip` | the 3:30 break: Admin round flip, remix, the **remix defence**, judging a Round 1 backlog while Round 2 is live, player mid-flip, two judges racing one item, closing submissions | 40s |
  | `flow4-identity-theme` | identity switching and its warnings, stale/unrostered players, theme toggle + pre-paint persistence, `/go`, the notice banner, editing a task after it scored, deleting a task that has submissions | 40s |
  | `flow5-admin` | `/admin` tabs, task add/edit/validation, roster copy and cross-round refusal, player/team delete guards, `/api/admin/health`, PIN gating of every admin + judge endpoint, feed past 60 approvals | 25s |
  | `flow6-scoring` | scoring invariants: once per team, best-of duplicates, fallback, bonus clamp, `/api/export` CSV, feed weight on a phone | 17s |
  | `flow7-concurrency` | 10 simultaneous reservations + bursts of 30/60 for **object-path collisions**, 10 real browsers uploading at once, team attribution, queue completeness, poll load | 10s |
  | `flow8-load` | the same shape with real iPhone-sized media (3 MB photos, a 20 MB clip past the tus chunk boundary), 12 phones, storage sizes, organizer screens under load. `QA_N` overrides the count | 12s |
  | `probe-admin-ui` | `/admin` as an organizer actually taps it: tab state, tap-a-task inline editor (title, points, video-only, secret), tap-a-player editor, event-tab controls | 20s |
  | `probe-cancel-race` | holds the finalize PATCH to force the cancel-vs-complete window — the `settled` ref. The UI must never say "Nothing was sent" about a queued row | 17s |
  | `probe-cancel-video` | the same two failures isolated from flow 1: video upload alone, a genuinely throttled mid-flight cancel, cancel racing completion | 14s |
  | `probe-groups-notes` | `group_id`: many files as one decision, notes reaching the judge, group forgery across teams/tasks, notes frozen once judged, the player's and the feed's collapsed view, counts meaning decisions not files | 23s |
  | `probe-loading` | holds each screen's data endpoint and asserts `/leaderboard`, `/feed`, `/judge`, `/submit` never claim a result during the pre-load window | 20s |
  | `probe-media` | media actually decodes: judge photo pixels, `<video>` with `#t=0.1` + `preload=auto` + `playsinline` + metadata, feed rendering | 14s |
  | `probe-secret` | secret challenges: hidden from the list *and* from `/api/state`, server refuses a guessed id, Reveal from the Secret challenges card, un-reveal, real secrets untouched | 16s |
  | `probe-truncation` | geometry of every name on `/`, `/leaderboard`, `/submit`, `/feed`, `/judge` at 390→260px, including an unbreakable team name. Zero clipping, no sideways scroll | 30s |
  | `probe-visibility` | `See` on a team's submissions, the judge reaching the **back** of the queue, rejected items in the feed and their filter, 320px overflow, and a filter outliving the control that clears it | 70s |

- `npm run smoke` — API-level suite; self-contained, doesn't import `qa/lib.mjs`.
- `npm test` — `node --test` over `scripts/*.test.mjs`. Pure functions, no DB, no dev server;
  this is where the task-sync planner is proved.
- `npm run ready` — read-only, ~2s, no dev server. Checks *the event* is configured, not that
  the app works, including whether the live task list still matches the board. Run it after
  anything that touches settings.
- `npm run build`, `npx tsc --noEmit`, `npx eslint src scripts qa --max-warnings=0`.

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
  `snapshot()`. `qa/run-all.mjs` fails any driver that doesn't print `real data intact: true`.
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
