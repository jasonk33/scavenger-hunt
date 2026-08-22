import { db, groupMemberIds } from "@/lib/db";
import { json, fail } from "@/lib/http";
import { cleanNote } from "@/lib/groups";
import type { Database } from "@/lib/database.types";

type SubmissionUpdate = Database["public"]["Tables"]["submissions"]["Update"];

export const dynamic = "force-dynamic";

/**
 * Step 2: the bytes landed in Storage, so promote the row into the judge queue.
 *
 * If this call never happens -- phone dies, browser closed mid-upload -- the row
 * stays `uploading` and simply never enters the queue. Nothing is silently
 * mis-scored, and the Admin screen lists stuck rows so they can be recovered.
 *
 * This route also carries note edits, because a note belongs to the whole group
 * rather than to one file and the player goes on typing after the first upload
 * has finished. `noteOnly` says which of the two calls this is EXPLICITLY rather
 * than inferring it from which fields happen to be present: a finalize whose
 * body lost its size field must not quietly become a note edit, because that
 * would leave the submission stuck in `uploading`, out of the queue and unscored
 * with nothing on any screen reporting a problem.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is fine */
  }

  const sb = db();

  if (body.noteOnly === true) {
    /*
     * Editing the note. This is the ONLY way a note is written -- the finalize
     * path below deliberately does not carry one. The player goes on typing
     * while the bytes are still moving, so a note folded into finalize would
     * capture whatever happened to be in the box at the instant tus finished,
     * and a second file finalizing later would then overwrite it.
     *
     * Allowed while the submission is still waiting, which is the entire window
     * in which a note can change the outcome. Once judged it is frozen: letting
     * a player rewrite the caption underneath a decision already made would put
     * something in the record the judge never actually saw.
     */
    const note = cleanNote(body.note);
    const { data: anchor } = await sb
      .from("submissions")
      .select("id,group_id,status")
      .eq("id", id)
      .maybeSingle();
    if (!anchor) return fail("Submission not found.", 404);
    if (anchor.status !== "uploading" && anchor.status !== "pending") {
      return fail("An organizer has already judged that one, so the note is locked.", 409);
    }

    // Written across every file in the group: the queue and the feed both read
    // rows on their own, so each file has to carry its own explanation.
    const { error } = await sb
      .from("submissions")
      .update({ note })
      .in("id", await groupMemberIds(anchor))
      .in("status", ["uploading", "pending"]);
    if (error) return fail(error.message, 500);
    return json({ ok: true, note });
  }

  const patch: SubmissionUpdate = { status: "pending" };
  if (typeof body.sizeBytes === "number") patch.size_bytes = Math.round(body.sizeBytes);
  if (typeof body.mediaType === "string" && body.mediaType) patch.media_type = body.mediaType;

  const { data, error } = await sb
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
