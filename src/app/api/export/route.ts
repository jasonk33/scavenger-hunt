import { db, mediaUrl } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
import { groupKey } from "@/lib/groups";
import { fail, slug } from "@/lib/http";

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

  const [{ data: subs }, { data: tasks }, { data: teams }, { data: players }, { data: scores }] =
    await Promise.all([
      sb.from("submissions").select("*").order("created_at"),
      sb.from("tasks").select("*").order("round").order("sort_order").order("id"),
      sb.from("teams").select("*").order("round").order("sort_order"),
      sb.from("players").select("*").order("name"),
      sb.from("team_scores").select("*"),
    ]);

  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t]));
  const playerById = new Map((players ?? []).map((p) => [p.id, p]));

  const rows = (subs ?? []).map((s) => ({
    id: s.id,
    round: s.round,
    team: teamById.get(s.team_id)?.name ?? "",
    player: playerById.get(s.player_id)?.name ?? "",
    task: taskById.get(s.task_id)?.title ?? "",
    taskPoints: s.task_points,
    status: s.status,
    pointsAwarded: s.points_awarded,
    total: s.status === "approved" ? (s.points_awarded ?? 0) : 0,
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
    // Same tiebreak as the view: the approval judged MOST RECENTLY wins, not the
    // highest one. Getting this wrong here is worse than getting it wrong on a
    // screen, because a spreadsheet total is what gets read out at the awards.
    const best = new Map<string, { id: string; at: string }>();
    for (const r of rows) {
      if (r.status !== "approved") continue;
      const k = `${r.round}:${r.team}:${r.task}`;
      const at = `${r.judgedAt ?? ""}|${r.createdAt}|${r.id}`;
      const prev = best.get(k);
      if (!prev || at > prev.at) best.set(k, { id: r.id, at });
    }
    const counted = new Set([...best.values()].map((b) => b.id));

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
        tasks: tasks ?? [],
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
