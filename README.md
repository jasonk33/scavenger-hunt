# Scavenger hunt app

Mobile web app for the birthday scavenger hunt. Players submit photos and video
from their phones, organizers judge and score live, everyone sees a leaderboard
and a feed.

No app install, no accounts, no passwords for players.

---

## Setup (about 15 minutes, once)

### 1. Supabase

Open the SQL editor in your Supabase project, paste in the whole of
`supabase/setup.sql`, and run it. Re-run it after pulling any change that
touches that file — the schema and the scoring view do not update themselves. That one file creates the tables and the
scoring view, turns on RLS, makes the `hunt` bucket with a 500 MB limit and the
right upload policies, and seeds 5 teams per round plus the 79 tasks from the
source doc. It is safe to re-run.

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

### 3. Load some data to play with (optional)

```bash
npm run demo          # 16 test players across 4 teams, remixed between rounds
npm run demo:reset    # remove them again
```

`demo:reset` also deletes **every submission and every media file** in the
project, so it refuses to run once real players have submitted anything. Use it
to clear your own testing before the day.

### 4. Verify it actually works

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

Open **Admin → health** for the same checks from the browser.

### 5. Deploy

```bash
npx vercel        # first run links the project
npx vercel --prod
```

Set the same four environment variables in the Vercel project settings.
Re-deploy after changing them.

---

## Running the event

**Before the day**

1. Admin → Roster → paste the guest list, one name per line.
2. Assign everyone to a Round 1 team. Assign Round 2 too, or use
   *Copy from Round 1* and adjust at the break.
3. Admin → health. Everything green.
4. Share the URL. Point any QR code at **`/go`**, not `/` — see Fallbacks below.

**Round 1 (1:00–2:30)**

- Players open the link, tap their name once, and upload against tasks.
- You sit in Judge. One tap approves at the task's value; the bonus and star are
  optional extra taps before approving.
- The star flags an award candidate. Use it freely — it's what makes the
  5:00–5:30 awards window fast.

**The break (2:30–3:30)**

1. Admin → Event → close submissions. Let the queue drain.
2. Admin → Roster → Round 2 → make the swaps.
3. Admin → Event → active round = 2, reopen submissions.

Nobody re-scans or re-joins anything. Round 1 scores cannot move: every
submission stored its team when it was created.

**Secret challenges**

Admin → Tasks → Reveal. Manual, not on a timer — the timer would fire while the
round is running late.

**Afterwards**

Admin → Event → Export:

- **CSV** — scoring detail for the awards
- **JSON** — the whole event
- **Media download script** — `bash download-media.sh` in an empty directory
  pulls every photo and video into round/team folders. Award candidates are
  prefixed `STAR--`.

---

## Fallbacks

Ranked by how likely you are to need them.

1. **The banner.** Admin → Event → Banner appears on every screen within 15
   seconds. This handles most "something is weird" moments without touching code.
2. **`/go`.** Point QR codes and shared links at `/go`. It redirects wherever
   `fallback_url` says, so you can move everyone without re-printing anything.
   For total-outage insurance, have the QR encode a re-targetable short link
   that points at `/go` — then the redirect survives even if the app doesn't.
3. **Text the organizer.** Announce a phone number at the start. If a player's
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
