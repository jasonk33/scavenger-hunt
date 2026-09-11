import { db, mediaUrl } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { groupKey } from "@/lib/groups";
import { fail, slug } from "@/lib/http";
import { scoreApproved } from "@/lib/scoring.mjs";

export const dynamic = "force-dynamic";

/**
 * Post-event export. Three formats off one query:
 *   (default) json  -- the whole event, for archival
 *   csv             -- scoring detail, opens in Sheets
 *   sh              -- a download script that pulls every media file into
 *                      round/team folders with readable names
 */
export async function GET(req: Request) {
  if (!(await isOrganizer())) return fail("Organizer PIN required.", 401);

  const format = new URL(req.url).searchParams.get("format") ?? "json";
  const sb = db();

  const [{ data: subs, error: subsError }, { data: tasks, error: tasksError },
    { data: teams, error: teamsError }, { data: players, error: playersError }, { data: scores, error: scoresError }] =
    await Promise.all([
      sb.from("submissions").select("id,round,task_id,player_id,team_id,task_points,scoring_mode_snapshot,points_per_unit_snapshot,measurement_value,object_name,media_type,size_bytes,status,points_awarded,reject_reason,group_id,note,created_at,judged_at").order("created_at"),
      sb.from("tasks").select("id,slug,round,title,doc_title,points,scoring_mode,measurement_label,points_per_unit,active,doc_order,sort_order,prop,note,rewrite,created_at,updated_at").order("round").order("sort_order").order("id"),
      sb.from("teams").select("*").order("round").order("sort_order"),
      sb.from("players").select("*").order("name"),
      sb.from("team_scores").select("*"),
    ]);
  if (subsError || tasksError || teamsError || playersError || scoresError) {
    return fail("Couldn't load the complete export. Try again.", 503);
  }

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));
  const effectiveById = new Map(
    scoreApproved(subs ?? [], tasks ?? []).map(({ row, points }) => [row.id, points])
  );

  const rows = (subs ?? []).map((s) => ({
    id: s.id,
    round: s.round,
    team: teamById.get(s.team_id)?.name ?? "",
    player: playerById.get(s.player_id)?.name ?? "",
    task: taskById.get(s.task_id)?.title ?? "",
    taskPoints: s.task_points,
    status: s.status,
    pointsAwarded: effectiveById.get(s.id) ?? s.points_awarded,
    total: s.status === "approved" ? (effectiveById.get(s.id) ?? s.points_awarded ?? 0) : 0,
    rejectReason: s.reject_reason,
    note: s.note,
    // Files sharing this are one piece of evidence, judged as a unit.
    groupId: groupKey(s),
    mediaType: s.media_type,
    sizeBytes: s.size_bytes,
    mediaUrl: mediaUrl(s.object_name),
    objectName: s.object_name,
    createdAt: s.created_at,
    judgedAt: s.judged_at,
  }));

  if (format === "csv") {
    // The judge screen deliberately allows approving a duplicate (a hard block
    // in the field is worse than a duplicate row), and `team_scores` counts a
    // task once. The CSV is the copy someone will actually total in Sheets, so
    // it has to carry the same dedup or a team gets credited twice and the
    // wrong team can win. `counts` is 1 only on the row that actually scores.
    //
    // Reuse the scoring selection, which keys by IDs, not mutable team names
    // or task titles. Different tasks are allowed to have identical wording.
    const counted = new Set(effectiveById.keys());

    const cols = [
      "round", "team", "player", "task", "status", "pointsAwarded",
      "total", "counts", "rejectReason", "note", "mediaUrl",
    ] as const;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const withCounts = rows.map((r) => ({ ...r, counts: counted.has(r.id) ? 1 : 0 }));
    const body = [
      cols.join(","),
      ...withCounts.map((r) => cols.map((c) => esc(r[c])).join(",")),
      "",
      "TEAM TOTALS (this is the authoritative score)",
      "round,team,points,tasksScored",
      ...(scores ?? [])
        .slice()
        .sort((a, b) => a.round - b.round || b.points - a.points)
        .map((s) => [s.round, esc(s.name), s.points, s.tasks_scored].join(",")),
    ];
    return new Response(body.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="scavenger-hunt.csv"',
        "cache-control": "no-store",
      },
    });
  }

  if (format === "sh") {
    const lines = [
      "#!/usr/bin/env bash",
      "# Downloads every submission into round/team folders.",
      "# Usage:  bash download-media.sh   (run it in an empty directory)",
      "set -euo pipefail",
      "",
    ];
    /*
     * Filenames have to be unique or `curl -o` silently overwrites.
     *
     * task--player is NOT unique: a submission with several files repeats it
     * once per file, and so does the same player redoing a task after a
     * rejection. Either way the script reports success while leaving a single
     * file on disk, and the evidence that went missing is invisible -- the same
     * failure the random suffix in the storage path exists to prevent, just
     * moved to download time. A counter on the second and later collisions
     * leaves the ordinary one-file name untouched.
     */
    const used = new Set<string>();
    const unique = (base: string, ext: string) => {
      let name = `${base}.${ext}`;
      for (let n = 2; used.has(name); n += 1) name = `${base}--${n}.${ext}`;
      used.add(name);
      return name;
    };

    for (const r of rows) {
      if (r.status === "rejected") continue;
      const dir = `round-${r.round}/${slug(r.team || "unknown")}`;
      const ext = r.objectName.split(".").pop() || "bin";
      const name = unique(
        `${dir}/${slug(r.task || "task", 60)}--${slug(r.player || "x", 20)}`,
        ext
      );
      lines.push(`mkdir -p ${JSON.stringify(dir)}`);
      lines.push(`curl -fsSL ${JSON.stringify(r.mediaUrl)} -o ${JSON.stringify(name)}`);
    }
    lines.push('echo "Done. $(find . -type f | wc -l) files."');
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "content-disposition": 'attachment; filename="download-media.sh"',
        "cache-control": "no-store",
      },
    });
  }

  return new Response(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        scores: scores ?? [],
        teams: teams ?? [],
        players: players ?? [],
        tasks: (tasks ?? []).map((task) => ({ ...task, scoring_mode: task.scoring_mode === "quantity" ? "quantity" : "fixed" })),
        submissions: rows,
      },
      null,
      2
    ),
    {
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="scavenger-hunt.json"',
        "cache-control": "no-store",
      },
    }
  );
}
