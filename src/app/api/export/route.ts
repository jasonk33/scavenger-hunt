import { db, mediaUrl } from "@/lib/db";
import { isOrganizer } from "@/lib/settings";
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
      sb.from("tasks").select("*").order("round").order("sort_order"),
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
    bonus: s.bonus,
    total: s.status === "approved" ? (s.points_awarded ?? 0) + (s.bonus ?? 0) : 0,
    starred: s.starred,
    rejectReason: s.reject_reason,
    mediaType: s.media_type,
    sizeBytes: s.size_bytes,
    mediaUrl: mediaUrl(s.object_name),
    objectName: s.object_name,
    createdAt: s.created_at,
    judgedAt: s.judged_at,
  }));

  if (format === "csv") {
    const cols = [
      "round", "team", "player", "task", "status", "pointsAwarded",
      "bonus", "total", "starred", "rejectReason", "mediaUrl",
    ] as const;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))];
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
    for (const r of rows) {
      if (r.status === "rejected") continue;
      const dir = `round-${r.round}/${slug(r.team || "unknown")}`;
      const ext = r.objectName.split(".").pop() || "bin";
      const star = r.starred ? "STAR--" : "";
      const name = `${star}${slug(r.task || "task", 60)}--${slug(r.player || "x", 20)}.${ext}`;
      lines.push(`mkdir -p ${JSON.stringify(dir)}`);
      lines.push(`curl -fsSL ${JSON.stringify(r.mediaUrl)} -o ${JSON.stringify(`${dir}/${name}`)}`);
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
        awardCandidates: rows.filter((r) => r.starred),
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
