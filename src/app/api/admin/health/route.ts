import { db, uploadConfig, SUPABASE_URL, BUCKET } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { json, fail, errorMessage } from "@/lib/http";

export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; detail: string };

/**
 * Pre-flight. Run this the day before, not on the day.
 *
 * Every check here corresponds to a failure that actually happened while
 * validating the upload path, and each one is invisible until a real file is
 * moving:
 *   - a publishable key instead of the legacy anon JWT ("Invalid Compact JWS")
 *   - a bucket that doesn't exist under the name in the env var
 *   - a missing INSERT policy
 *   - the 50 MB default file size limit, which 413s most videos
 *
 * The storage check is a real upload, not a metadata read. `storage.buckets` has
 * its own RLS that anonymous keys generally cannot read, so a metadata check
 * reports "not found" for buckets that exist and work fine.
 */
export async function GET() {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);

  const checks: Check[] = [];
  const up = uploadConfig();

  checks.push({
    name: "SUPABASE_URL",
    ok: /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL),
    detail: SUPABASE_URL || "not set",
  });

  checks.push({
    name: "Service role key",
    ok: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set" : "not set",
  });

  checks.push({
    name: "Upload key is a JWT",
    ok: up.keyLooksValid,
    detail: up.keyLooksValid
      ? "legacy anon key — correct"
      : "Storage needs the LEGACY anon key (starts with eyJ). Settings → API Keys → 'Legacy anon, service_role API keys'.",
  });

  checks.push({
    name: "Organizer PIN",
    ok: Boolean(process.env.ORGANIZER_PIN),
    detail: process.env.ORGANIZER_PIN ? "set" : "not set — Judge and Admin are open to anyone",
  });

  // Database reachability and whether the seed actually ran.
  try {
    const sb = db();
    const [{ count: taskCount }, { count: teamCount }, { count: playerCount }] = await Promise.all([
      sb.from("tasks").select("id", { count: "exact", head: true }),
      sb.from("teams").select("id", { count: "exact", head: true }),
      sb.from("players").select("id", { count: "exact", head: true }),
    ]);
    checks.push({
      name: "Database",
      ok: true,
      detail: `${taskCount ?? 0} tasks, ${teamCount ?? 0} teams, ${playerCount ?? 0} players`,
    });
    checks.push({
      name: "Seed data loaded",
      ok: Boolean(taskCount && teamCount),
      detail: taskCount ? "yes" : "run npm run sync:tasks -- --apply",
    });
    checks.push({
      name: "Players added",
      ok: Boolean(playerCount),
      detail: playerCount ? `${playerCount} players` : "nobody can join yet — add players in Roster",
    });
  } catch (e) {
    checks.push({ name: "Database", ok: false, detail: errorMessage(e) });
  }

  // The real test: can a browser-equivalent anon request actually write a file?
  if (up.keyLooksValid && SUPABASE_URL) {
    const probe = `__healthcheck/${Date.now()}.txt`;
    try {
      const res = await fetch(
        `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(BUCKET)}/${probe}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${up.anonKey}`,
            apikey: up.anonKey,
            "content-type": "text/plain",
            "x-upsert": "true",
          },
          body: "ok",
        }
      );

      if (res.ok) {
        checks.push({ name: "Storage write (anon)", ok: true, detail: `bucket "${BUCKET}" accepts uploads` });

        const pub = await fetch(
          `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(BUCKET)}/${probe}`
        );
        checks.push({
          name: "Storage public read",
          ok: pub.ok,
          detail: pub.ok
            ? "media will play in the judge screen"
            : "bucket is not public — the judge screen and feed will show broken media",
        });

        await db().storage.from(BUCKET).remove([probe]).catch(() => {});
      } else {
        const body = await res.text().catch(() => "");
        const detail =
          res.status === 404
            ? `Bucket "${BUCKET}" not found. Create it, or fix SUPABASE_BUCKET.`
            : res.status === 403
              ? "Blocked by policy. Run supabase/setup.sql."
              : res.status === 401
                ? "Key rejected. Use the legacy anon key."
                : res.status === 413
                  ? "File size limit too low. Raise it to 500 MB."
                  : `HTTP ${res.status} ${body.slice(0, 160)}`;
        checks.push({ name: "Storage write (anon)", ok: false, detail });
      }
    } catch (e) {
      checks.push({ name: "Storage write (anon)", ok: false, detail: errorMessage(e) });
    }
  }

  // Storage's global file size limit is a project setting, not a bucket one, and
  // its 50 MB default is below a typical iPhone video.
  try {
    const { data } = await db().storage.getBucket(BUCKET);
    const limit = data?.file_size_limit ?? null;
    checks.push({
      name: "File size limit",
      ok: !limit || limit >= 209715200,
      detail: limit
        ? `${(limit / 1048576).toFixed(0)} MB${limit < 209715200 ? " — too low, videos will fail. Set 500 MB." : ""}`
        : "no bucket-level limit set (check the global limit in Storage → Settings)",
    });
  } catch {
    /* non-fatal */
  }

  return json({ ok: checks.every((c) => c.ok), checks });
}
