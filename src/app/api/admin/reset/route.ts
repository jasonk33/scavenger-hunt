import { db, BUCKET } from "@/lib/db";
import { isOrganizer, resetEnabled, setSetting } from "@/lib/settings";
import { json, fail } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Back to a clean slate for testing: every submission gone, along with the media
 * each one uploaded, every leader bonus un-awarded, and every phone's starred
 * shortlist cleared.
 *
 * It sweeps the submissions, not the bucket, so bytes left behind by an upload
 * that was cancelled before its row survived are not its problem -- those cost
 * storage and nothing else, and reaching past the rows to delete them would mean
 * deleting objects nothing in the database claims.
 *
 * This is the most destructive thing in the app and there is no undo -- Storage
 * deletes are permanent and the photos are the only copy. So it is guarded three
 * deep: the organizer PIN, the ALLOW_RESET environment switch, and a confirm
 * word that has to arrive in the body. The last one is what stops a stray fetch
 * or a fat finger; an accidental request cannot supply it.
 *
 * It stops at submissions on purpose. Players, teams, the roster, the task list
 * and secret reveals all survive, so a reset costs a re-upload rather than a
 * re-seed. `npm run seed:reset` is still the way to rebuild the rest.
 */
const CONFIRM_WORD = "RESET";

// PostgREST requires a filter on a delete, so match everything by excluding an
// id that cannot exist. Same shape the seed script uses.
const NO_SUCH_ID = "00000000-0000-0000-0000-000000000000";

export async function POST(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);
  if (!resetEnabled())
    return fail("Reset is switched off. Set ALLOW_RESET=1 in the environment to enable it.", 403);

  const body = await req.json().catch(() => ({}));
  if ((body as { confirm?: unknown })?.confirm !== CONFIRM_WORD)
    return fail(`Type ${CONFIRM_WORD} to confirm.`, 400);

  const sb = db();

  // Paged, because PostgREST caps how many rows one select returns and the
  // delete below is not capped: reading a single page and then deleting
  // everything would strand the rest of the media in the bucket with no record
  // of what it was -- the exact failure the ordering below exists to avoid.
  // Termination is by an empty page rather than a short one, so it stays correct
  // whatever the server's row cap turns out to be.
  const subs: Array<{ id: string; object_name: string }> = [];
  for (let from = 0; ; ) {
    const { data, error } = await sb
      .from("submissions")
      .select("id,object_name")
      .order("id")
      .range(from, from + 1000 - 1);
    // Nothing is deleted if the list could not be read. Deleting the rows first
    // and only then discovering the object names are unreadable would strand
    // every file in the bucket with no record of what it was.
    if (error) return fail(`Could not read submissions: ${error.message}`, 500);
    if (!data?.length) break;
    subs.push(...data);
    from += data.length;
  }

  const objects = subs.map((s) => s.object_name).filter(Boolean);

  // Media first, rows second. The other order leaves rows pointing at files that
  // are already gone, which is a judge screen full of broken evidence; this
  // order can only leave unreferenced files behind, which costs storage and
  // nothing else. Storage.remove caps a call at 100 keys.
  let orphaned = 0;
  for (let i = 0; i < objects.length; i += 100) {
    const batch = objects.slice(i, i + 100);
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) orphaned += batch.length;
  }

  const { error: delErr } = await sb.from("submissions").delete().neq("id", NO_SUCH_ID);
  if (delErr) return fail(`Media was deleted but the rows were not: ${delErr.message}`, 500);

  // A leader bonus is an award made over submissions that no longer exist, so it
  // has to go too -- otherwise a wiped leaderboard still shows bonus points and
  // Admin still lists the contest as decided.
  const { error: winnerErr } = await sb
    .from("tasks")
    .update({ winner_team_id: null })
    .not("winner_team_id", "is", null);

  // The starred shortlists are localStorage on each phone, so nothing here can
  // delete them. Bumping this marker is the signal: every device clears its own
  // the first time /api/state hands it a value it has not seen before. Written
  // last, so a reset that failed half way through does not tell 24 phones to
  // throw away a shortlist that still matches live submissions.
  await setSetting("saved_epoch", String(Date.now()));

  return json({
    ok: true,
    submissions: subs.length,
    objects: objects.length,
    orphaned,
    winnersCleared: !winnerErr,
  });
}
