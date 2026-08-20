import { db } from "@/lib/db";
import { json, fail } from "@/lib/http";
import type { Database } from "@/lib/database.types";

type SubmissionUpdate = Database["public"]["Tables"]["submissions"]["Update"];

export const dynamic = "force-dynamic";

/**
 * Step 2: the bytes landed in Storage, so promote the row into the judge queue.
 *
 * If this call never happens -- phone dies, browser closed mid-upload -- the row
 * stays `uploading` and simply never enters the queue. Nothing is silently
 * mis-scored, and the Admin screen lists stuck rows so they can be recovered.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const patch: SubmissionUpdate = { status: "pending" };
  if (typeof body.sizeBytes === "number") patch.size_bytes = Math.round(body.sizeBytes);
  if (typeof body.mediaType === "string" && body.mediaType) patch.media_type = body.mediaType;

  const { data, error } = await db()
    .from("submissions")
    .update(patch)
    .eq("id", id)
    .eq("status", "uploading") // never resurrect something already judged
    .select("id,status")
    .maybeSingle();

  if (error) return fail(error.message, 500);
  if (!data) return fail("That submission was already finalized.", 409);
  return json({ ok: true, submission: data });
}

/** Discard a submission whose upload failed, so the queue isn't littered. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { error } = await db().from("submissions").delete().eq("id", id).eq("status", "uploading");
  if (error) return fail(error.message, 500);
  return json({ ok: true });
}
