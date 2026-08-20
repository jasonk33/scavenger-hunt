import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * Server-only Supabase client using the service_role key.
 *
 * Every database read and write in this app goes through a route handler using
 * this client. RLS is enabled with no policies, so the anon key cannot touch the
 * tables at all. That means point values, round and team attribution are always
 * resolved server-side from the roster and the tasks table -- the browser never
 * gets to assert them.
 *
 * Media bytes are the one exception: they go browser -> Storage directly,
 * because Vercel caps request bodies at 4.5 MB and videos run to 150 MB.
 */

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return v;
}

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
export const BUCKET = process.env.SUPABASE_BUCKET || "hunt";

let cached: ReturnType<typeof createClient<Database>> | null = null;

export function db() {
  if (!cached) {
    cached = createClient<Database>(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

/** Public URL for a stored object. The bucket is public, so no signing needed. */
export function mediaUrl(objectName: string): string {
  const path = objectName.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

/**
 * Upload credentials handed to the browser at runtime rather than baked in as
 * NEXT_PUBLIC_* at build time, so a wrong key is fixed by changing one env var
 * instead of hunting a stale bundle.
 *
 * This MUST be the legacy `anon` JWT. Supabase Storage requires an Authorization
 * header and requires it to be a JWT; the newer `sb_publishable_...` keys are not
 * JWTs and fail with "Invalid Compact JWS". Verified empirically.
 */
export function uploadConfig() {
  const key = process.env.SUPABASE_ANON_KEY ?? "";
  const ref = (SUPABASE_URL.match(/^https:\/\/([a-z0-9]+)\.supabase\./i) || [])[1] ?? "";
  return {
    endpoint: `https://${ref}.storage.supabase.co/storage/v1/upload/resumable`,
    anonKey: key,
    bucket: BUCKET,
    keyLooksValid: /^ey[A-Za-z0-9_-]+\./.test(key),
  };
}
