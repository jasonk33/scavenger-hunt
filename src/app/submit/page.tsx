"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage, fmtBytes, getMe, getSaved, inkOn, setMe, setSaved, syncSavedEpoch, usePoll, type Me } from "@/lib/client";
import { groupBy, NOTE_MAX } from "@/lib/groups";
import { isJwt, isVideoFile, playableType, uploadFile, createWakeLock, type UploadHandle } from "@/lib/upload";
import EvidenceEntryCard, { type EvidenceEntry } from "@/components/EvidenceEntry";
import Score from "@/components/Score";

type Task = {
  id: string;
  title: string;
  points: number;
  scoring_mode: "fixed" | "quantity" | "competition";
  measurement_label: string;
  points_per_unit: number;
  competition_bonus: number;
  /** Set once an organizer picks the leader-bonus winner at the end of a round. */
  competition: { team: string; bonus: number } | null;
  requires_video: boolean;
  is_secret: boolean;
};

type Sub = {
  id: string;
  task_id: string;
  player_id: string;
  status: "uploading" | "pending" | "approved" | "rejected";
  points_awarded: number | null;
  /** What the task was worth, and what the team earned on top of it. Null until
      the judge has ruled, which is not the same as zero. */
  basePoints: number | null;
  bonusPoints: number;
  measurement_value: number | null;
  reject_reason: string | null;
  created_at: string;
  judged_at: string | null;
  /** Files sharing this are one piece of evidence, judged as a unit. */
  groupId: string;
  note: string | null;
  mediaUrl: string;
  isVideo: boolean;
  playerName: string;
};

type Rejection = {
  id: string;
  taskId: string;
  taskTitle: string;
  reason: string | null;
  at: string;
};

type OtherTeamEntries = {
  entries: EvidenceEntry[];
};

/**
 * Where a task has got to, for this team, in this round.
 *
 * One implementation, three call sites: the status filter, the pill on the card
 * and the card's own tint. Written out three times they would agree only by
 * copy-paste, and the first disagreement is a card tinted green while the chip
 * row insists it is still to do.
 *
 * Approved wins over a stale rejection the team has already redone, and a retry
 * already with the judge wins over the rejection it is answering -- so the only
 * thing that reads as "rejected" is a task that genuinely still needs the work.
 * That is the same precedence the pill has always used.
 */
type TaskStatus = "todo" | "waiting" | "rejected" | "done";

function statusOf(subs: readonly Sub[] | undefined): TaskStatus {
  if (!subs || subs.length === 0) return "todo";
  if (subs.some((s) => s.status === "approved")) return "done";
  if (subs.some((s) => s.status === "pending" || s.status === "uploading")) return "waiting";
  if (subs.some((s) => s.status === "rejected")) return "rejected";
  return "todo";
}

/**
 * The four buckets on the chip row. "Sent" deliberately covers both scored and
 * still-with-the-judge: from the player's side they are the same thing -- work
 * that is done and needs nothing further -- and splitting them would put a
 * fifth chip on a row that has to fit a 320px phone.
 */
const STATUS_FILTERS = [
  { key: "all", label: "All" },
  { key: "todo", label: "To do" },
  { key: "rejected", label: "Rejected" },
  { key: "sent", label: "Sent" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["key"];

function matchesStatus(filter: StatusFilter, status: TaskStatus): boolean {
  if (filter === "all") return true;
  if (filter === "sent") return status === "done" || status === "waiting";
  return status === filter;
}

/**
 * What each bucket says when it comes up empty. `noun` is the bucket read as an
 * adjective mid-sentence -- "No untouched tasks match", which the chip labels
 * themselves cannot give you ("No to do tasks match").
 */
const STATUS_EMPTY: Record<
  Exclude<StatusFilter, "all">,
  { noun: string; title: string; body: string }
> = {
  todo: {
    noun: "untouched",
    title: "Nothing left untouched",
    body: "Your team has sent something for every task in this round. Redo one for a better shot at it.",
  },
  rejected: {
    noun: "rejected",
    title: "Nothing rejected",
    body: "Nobody has had anything thrown out yet. Keep it that way.",
  },
  sent: {
    noun: "sent",
    title: "Nothing sent yet",
    body: "Pick a task and upload something — a photo or a clip, either works.",
  },
};

type State = {
  settings: { round: number; submissions_open: boolean; saved_epoch: string };
  me: Me | null;
  team: { id: string; name: string; color: string } | null;
  tasks: Task[];
  submissions: Sub[];
  stats: {
    submitted: number;
    pending: number;
    approved: number;
    rejected: number;
    points: number;
  };
  rejections: Rejection[];
  upload: { endpoint: string; anonKey: string; bucket: string };
};

type Job = {
  task: Task;
  fileName: string;
  size: number;
  /**
   * The picked file itself, as a local object URL, so the card shows what is
   * being sent while it is being sent. Revoked when the job is replaced or
   * dismissed -- an iPhone clip is 150MB and holding several would be careless.
   */
  preview: { url: string; isVideo: boolean } | null;
  /** Distinguishes one job from the next in the same card. The scroll-into-view
      effect keys on it, so picking a second file brings the card back into
      view rather than leaving it wherever the page had scrolled to. */
  startedAt: number;
  pct: number;
  retries: number;
  status: "uploading" | "done" | "error";
  message?: string;
  /**
   * The submission every file in this batch hangs off, set as soon as the row is
   * reserved rather than when the bytes land -- so the note field is live while
   * the upload is still running, which is the dead time the player would
   * otherwise spend watching a progress bar.
   */
  anchorId: string | null;
  /** The note the group already carries, so the editor never opens blank over
      an explanation the team has already written. */
  note: string;
  /**
   * Whether anything in this batch actually reached the queue. A failure after
   * one file has landed is a very different message from a failure on the
   * first: telling the player nothing was sent would have them re-upload
   * something that is already waiting to be judged.
   */
  sent: boolean;
};

export default function SubmitPage() {
  const router = useRouter();
  const [me, setMeState] = useState<Me | null>(null);
  const [q, setQ] = useState("");
  // Loaded from localStorage alongside `me`, never before it. The task list is
  // gated on `me`, so the saved set is always ready by the time a star renders
  // -- no frame where every task claims to be unsaved.
  const [saved, setSavedState] = useState<Set<string>>(new Set());
  const [onlySaved, setOnlySaved] = useState(false);
  /** Show one points tier only, or all of them. Navigation, not scoring. */
  const [tier, setTier] = useState<number | null>(null);
  /** Which of the four buckets to show. The most-used filter on the screen, so
      it is the one that stays out in the open. */
  const [status, setStatus] = useState<StatusFilter>("all");
  /** Whether the points and saved filters are unfolded. They start folded
      because on a 50-task list the status row is what people reach for, and
      four stacked controls leave barely a card above the fold. */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [switching, setSwitching] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingTask = useRef<Task | null>(null);
  // Set when the picker was opened by "Add another": the submission the next
  // file joins rather than stands beside, plus the note that group already
  // carries. Without the note the editor would open blank over an explanation
  // the team had already written, and typing would replace it unseen.
  const pendingGroup = useRef<{ anchorId: string; note: string } | null>(null);
  const handle = useRef<UploadHandle | null>(null);
  const currentSubmissionId = useRef<string | null>(null);
  // Set the moment tus reports success. From that point the bytes are already in
  // Storage and the row is being promoted, but the progress card is still
  // rendering "uploading" -- so Cancel is still on screen and still tappable.
  const settled = useRef(false);
  const wakeRef = useRef<ReturnType<typeof createWakeLock> | null>(null);
  if (!wakeRef.current) wakeRef.current = createWakeLock();
  const wake = wakeRef.current;

  /* One preview is alive at a time. Revoking the previous URL as soon as it is
     replaced -- and on unmount -- keeps a run of 150MB clips from piling up in
     memory on a phone that has to last the afternoon. */
  useEffect(() => {
    const url = job?.preview?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [job?.preview?.url]);

  useEffect(() => {
    const m = getMe();
    if (!m) router.replace("/");
    else {
      setMeState(m);
      setSavedState(getSaved(m.id));
    }
  }, [router]);

  const { data, reload, error } = usePoll<State>(
    me ? `/api/state?playerId=${encodeURIComponent(me.id)}` : null,
    5000
  );

  // The server is the authority on who exists. If a player row was deleted or
  // this device has stale identity, send them back rather than letting every
  // submission fail with a confusing error.
  useEffect(() => {
    if (data && me && !data.me) {
      setMe(null);
      router.replace("/");
    }
  }, [data, me, router]);

  /* An organizer resetting the event deletes every submission, which makes a
     shortlist of tasks this team already "did" worse than no shortlist at all.
     The stars are on this device, so the reset can only leave a marker: clear
     them the first time we poll one we have not seen. On a poll rather than a
     reload, because a phone sitting in a pocket must not come back to a
     shortlist of work that no longer exists. */
  const epoch = data?.settings.saved_epoch;
  useEffect(() => {
    if (epoch === undefined) return;
    if (syncSavedEpoch(epoch)) setSavedState(new Set());
  }, [epoch]);

  const byTask = useMemo(() => {
    const m = new Map<string, Sub[]>();
    for (const s of data?.submissions ?? []) {
      const list = m.get(s.task_id) ?? [];
      list.push(s);
      m.set(s.task_id, list);
    }
    return m;
  }, [data]);

  /* Every task's bucket, computed once against the round's whole list rather
     than inside the filter, because the empty state below reads it twice and
     needs both answers: which tasks are in the bucket, and whether the bucket
     has anything in it AT ALL this round. Told only that the filtered list is
     empty, the empty state cannot tell "two rejections are sitting behind a
     points chip" from "nothing was ever rejected", and blaming the chip for the
     second is the wrong-cause bug all three empty states exist to avoid. */
  const statusByTask = useMemo(() => {
    const m = new Map<string, TaskStatus>();
    for (const t of data?.tasks ?? []) m.set(t.id, statusOf(byTask.get(t.id)));
    return m;
  }, [data, byTask]);

  const tasks = useMemo(() => {
    const list = data?.tasks ?? [];
    const needle = q.trim().toLowerCase();
    const found = needle ? list.filter((t) => t.title.toLowerCase().includes(needle)) : list;
    const tiered = tier === null ? found : found.filter((t) => t.points === tier);
    const bucketed =
      status === "all"
        ? tiered
        : tiered.filter((t) => matchesStatus(status, statusByTask.get(t.id) ?? "todo"));
    return onlySaved ? bucketed.filter((t) => saved.has(t.id)) : bucketed;
  }, [data, q, tier, status, statusByTask, onlySaved, saved]);

  /* Derived from the round's whole task list rather than from `tasks`, for the
     same reason the saved count is: the chips must not rearrange themselves
     under the thumb as the player types, and a chip that vanished while its own
     filter was still on would leave them on an empty list with nothing marked
     as the cause of it. That last case is not hypothetical -- an organizer
     cutting the last task of a tier empties it out from under whoever is
     reading it -- so the selected tier is added back in even once no task
     carries it, exactly as the saved chip stays put at zero saved tasks.
     Tiers are not hardcoded: they are edited live from the canvas, and the
     7-pointers were cut entirely at one point. */
  const tiers = useMemo(() => {
    const set = new Set((data?.tasks ?? []).map((t) => t.points));
    if (tier !== null) set.add(tier);
    return [...set].sort((a, b) => a - b);
  }, [data, tier]);

  /* Counted against the round's live task list rather than the stored set, so
     ids left behind by the remix or by a task an organizer cut never inflate
     the number the chip shows.

     Two numbers, because the chip's presence and the chip's number answer
     different questions. `savedInRound` is how many stars survive into this
     round -- it decides whether the control exists at all, and it is what the
     saved empty state means when it says "none of your saved tasks are in this
     round". `savedShown` is how many you would actually get if you tapped it
     from where you are standing. */
  const savedInRound = useMemo(
    () => (data?.tasks ?? []).filter((t) => saved.has(t.id)).length,
    [data, saved]
  );

  /* Narrowed by the status tab and nothing else. "★ Saved · 5" above a list of
     two was the complaint, and the tab is what makes the difference -- but the
     points chips and the search deliberately do not count here. The search
     would rewrite the number under the player's thumb on every keystroke, and
     the points chips share the fold with this one, so a count that moved with
     them would make the saved empty state's "none of your saved tasks are in
     this round" mean two different things depending on which chip was lit. */
  const savedShown = useMemo(
    () =>
      (data?.tasks ?? []).filter(
        (t) => saved.has(t.id) && matchesStatus(status, statusByTask.get(t.id) ?? "todo")
      ).length,
    [data, saved, status, statusByTask]
  );

  const toggleSaved = (taskId: string) => {
    if (!me) return;
    /* Re-read storage at the moment of the tap rather than trusting the set
       this render closed over. Two things break if we trust the closure: a
       second tab (or a duplicate of this page opened from the QR code) holds a
       snapshot from ITS mount, and writing the whole set back would silently
       destroy every star the other tab added. Reading first makes localStorage
       the single source of truth and makes the write a merge, so no tap is ever
       lost. It also removes the stale-closure hazard in two toggles dispatched
       from one commit. The other tab's display stays stale until it reloads,
       which is cosmetic -- nothing is lost. */
    const next = getSaved(me.id);
    if (next.has(taskId)) next.delete(taskId);
    else next.add(taskId);
    setSaved(me.id, next);
    setSavedState(next);
  };

  const grouped = useMemo(() => {
    const g = new Map<number, Task[]>();
    for (const t of tasks) {
      const list = g.get(t.points) ?? [];
      list.push(t);
      g.set(t.points, list);
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks]);

  /**
   * Open the file picker for a task. `groupWith` names a submission the new file
   * is another angle on, rather than a separate piece of evidence -- passed
   * straight through to the server, which decides whether the two may actually
   * be grouped.
   */
  const pickFor = (task: Task, group?: { anchorId: string; note: string }) => {
    pendingTask.current = task;
    pendingGroup.current = group ?? null;
    fileInput.current?.click();
  };

  /**
   * tus's abort(true) suppresses every callback -- neither onError nor onSuccess
   * fires afterwards. So cancelling has to drive the terminal state itself, or
   * the job sticks at "uploading" forever, which leaves every Upload button on
   * the page disabled and the progress card impossible to dismiss.
   */
  const cancelUpload = () => {
    // Once tus has succeeded there is nothing left to cancel: the bytes are in
    // Storage and the row is mid-promotion. Claiming "Nothing was sent" here
    // would send the player off to re-upload something already in the queue.
    if (settled.current) return;
    handle.current?.abort();
    handle.current = null;
    wake.release();
    const id = currentSubmissionId.current;
    currentSubmissionId.current = null;
    if (id) void api(`/api/submissions/${id}`, { method: "DELETE" }).catch(() => {});
    setJob(
      (j) =>
        j && {
          ...j,
          status: "error",
          message: j.sent
            ? "Cancelled. The file before it is still in the queue."
            : "Cancelled. Nothing was sent.",
          // The row this note would have been saved against has just been
          // deleted. Unless an earlier file in the batch survived, there is
          // nothing left to attach a note to.
          anchorId: j.sent ? j.anchorId : null,
        }
    );
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset immediately so picking the SAME file twice still fires a change event.
    e.target.value = "";
    const task = pendingTask.current;
    const group = pendingGroup.current;
    const groupWith = group?.anchorId;
    pendingTask.current = null;
    pendingGroup.current = null;
    if (!file || !task || !me || !data) return;

    if (!isJwt(data.upload.anonKey)) {
      setJob({
        task,
        fileName: file.name,
        size: file.size,
        preview: null,
        startedAt: Date.now(),
        pct: 0,
        retries: 0,
        status: "error",
        anchorId: null,
        note: "",
        sent: false,
        message:
          "The upload key on the server isn't valid. Tell an organizer: it must be the legacy anon key.",
      });
      return;
    }

    // Made BEFORE the updater, which has to stay pure: React invokes it twice
    // under StrictMode, and a second URL minted in there is never revoked.
    const previewUrl = URL.createObjectURL(file);
    setJob((prev) => ({
      task,
      fileName: file.name,
      size: file.size,
      // Rendered locally, so the player can check they picked the right clip
      // without waiting for it to land anywhere.
      preview: { url: previewUrl, isVideo: isVideoFile(file) },
      startedAt: Date.now(),
      pct: 0,
      retries: 0,
      status: "uploading",
      // Another angle on the batch already on screen keeps its anchor, so the
      // note the player has been typing stays attached to the same group.
      anchorId: groupWith && prev?.anchorId === groupWith ? prev.anchorId : null,
      note: groupWith && prev?.anchorId === groupWith ? prev.note : (group?.note ?? ""),
      // Joining a group that is ALREADY in the queue counts as sent: cancelling
      // this file must not claim nothing was sent while its siblings wait to be
      // judged. That is the message this flag exists to prevent.
      sent: Boolean(groupWith) && (prev?.anchorId === groupWith ? Boolean(prev?.sent) : true),
    }));
    settled.current = false;

    let submissionId: string;
    let objectName: string;
    let contentType: string;
    try {
      // Reserve the row first. The server decides round, team and points; the
      // client only names a task and a file.
      const init = await api<{ submissionId: string; objectName: string; contentType: string }>(
        "/api/submissions",
        {
          method: "POST",
          body: JSON.stringify({
            playerId: me.id,
            taskId: task.id,
            fileName: file.name,
            fileType: file.type,
            groupWith: groupWith ?? undefined,
          }),
        }
      );
      submissionId = init.submissionId;
      objectName = init.objectName;
      contentType = init.contentType;
      currentSubmissionId.current = submissionId;
      // The row exists from here, so a note can be saved against it even though
      // the bytes are still moving.
      setJob((j) => j && { ...j, anchorId: j.anchorId ?? submissionId });
    } catch (err) {
      setJob(
        (j) =>
          j && { ...j, status: "error", message: errorMessage(err, "Could not start."), anchorId: j.sent ? j.anchorId : null }
      );
      return;
    }

    await wake.acquire();

    handle.current = uploadFile({
      file,
      objectName,
      // Server and client compute this the same way; passing the server's answer
      // keeps the stored content-type and the DB row from ever disagreeing.
      contentType: contentType || playableType(file),
      config: data.upload,
      onProgress: (sent, total) =>
        setJob((j) => j && { ...j, pct: Math.round((sent / total) * 100) }),
      onRetry: (n) => setJob((j) => j && { ...j, retries: n }),
      onError: (message) => {
        wake.release();
        handle.current = null;
        currentSubmissionId.current = null;
        setJob(
          (j) => j && { ...j, status: "error", message, anchorId: j.sent ? j.anchorId : null }
        );
        // Drop the placeholder row so it doesn't linger as a phantom submission.
        void api(`/api/submissions/${submissionId}`, { method: "DELETE" }).catch(() => {});
      },
      onSuccess: async () => {
        settled.current = true;
        wake.release();
        handle.current = null;
        currentSubmissionId.current = null;
        try {
          await api(`/api/submissions/${submissionId}`, {
            method: "PATCH",
            body: JSON.stringify({ sizeBytes: file.size, mediaType: contentType }),
          });
          setJob((j) => j && { ...j, pct: 100, status: "done", sent: true });
          reload();
        } catch (err) {
          // The bytes ARE in Storage; only the registration failed. Say so, and
          // leave the row for Admin to promote rather than deleting the media.
          setJob(
            (j) =>
              j && {
                ...j,
                status: "error",
                sent: true,
                message: `Uploaded, but couldn't register it: ${errorMessage(err)}. Tell an organizer — the file did arrive.`,
              }
          );
        }
      },
    });
  };

  if (!me) return <p className="muted" style={{ marginTop: 24 }}>Loading…</p>;

  const s = data?.stats;
  const closed = data && !data.settings.submissions_open;
  // One gate, two buttons: the retry button on a rejection and every task row's
  // Upload button open the same file picker, so they must agree about when that
  // is allowed. Written out twice they agreed only by copy-paste.
  const uploadBlocked = Boolean(closed) || !data?.team || job?.status === "uploading";
  // Whether the card below can render where the player is actually looking.
  const jobIsListed = Boolean(job && tasks.some((t) => t.id === job.task.id));

  /* Which control actually emptied the saved list. The unsaved empty state
     below already branches on this; the saved one used to name the points
     filter unconditionally, which told a player looking at a chip row reading
     "All" to go and clear a filter they had never set. Naming the wrong
     control is the same small bug both empty states avoid. Only reached with
     the status filter off, which is what keeps it to these three cases. */
  const savedNarrowedBy =
    tier !== null && q.trim() ? "both" : tier !== null ? "tier" : "search";

  /* The folded filters, named rather than counted, so the button that hides
     them says what it is hiding. A bare dot would leave a player looking at a
     short list with nothing on screen telling them why -- the strand shape,
     one fold further in. */
  const foldedFilters = [
    tier !== null ? `${tier} pt${tier === 1 ? "" : "s"}` : null,
    onlySaved ? "★ saved" : null,
  ].filter(Boolean) as string[];

  /* Rendered on the same terms the controls inside it are: a fold with nothing
     in it is just a button that opens an empty box. */
  const showTiers = Boolean(data) && (tiers.length > 1 || tier !== null);
  const showSaved = savedInRound > 0 || onlySaved;
  /* Held back until the team has actually sent something. Before that every
     task is To do and the row filters nothing -- and it cannot strand anyone by
     disappearing, because it only disappears while set to All. */
  const showStatus = Boolean(data) && ((data?.submissions.length ?? 0) > 0 || status !== "all");

  /** Back to the whole list, whichever combination got them here. */
  const clearFilters = () => {
    setStatus("all");
    setTier(null);
    setOnlySaved(false);
    setQ("");
  };

  /* Whether the chosen bucket has ANY member in the round, which is a different
     question from whether the filtered list came back empty -- and the whole
     reason statusByTask is built against the round rather than inside the
     filter. Without it, filtering to Rejected in a round with nothing rejected
     announced that a search was narrowing it, when the search was narrowing
     nothing and the real answer never got said. */
  const bucketInRound =
    status === "all" || [...statusByTask.values()].some((s) => matchesStatus(status, s));

  /* What the status empty state has to own up to. Named individually rather
     than counted, because "3 filters are on" tells a player nothing they can
     act on -- and the search box in particular is the one they will not think
     of, since its text is sitting right there looking deliberate. */
  const alsoNarrowing = [
    tier !== null ? `the ${tier}-point filter` : null,
    onlySaved ? "the saved filter" : null,
    q.trim() ? "your search" : null,
  ].filter(Boolean) as string[];
  /* Only the other filters can be blamed, and only when there is something in
     the bucket for them to be hiding. */
  const blameOtherFilters = bucketInRound && alsoNarrowing.length > 0;

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        // No `capture` attribute on purpose: people shoot first and upload after,
        // so they must be able to pick a clip from their camera roll.
        accept="image/*,video/*"
        onChange={onFile}
        style={{ display: "none" }}
      />

      {/* Tapping your own name switches player. Mis-taps on the join list are
          the realistic mistake here, and picking the wrong name can put you on
          the wrong TEAM -- which means your uploads credit the wrong
          scoreboard. So this has to be obvious, not buried at the bottom.

          Two lines rather than one: sharing a row with the team pill left a long
          team name to squeeze the h1, and a player looking at their own name
          rendered as "E." has no way to tell whether they picked the right
          person. On its own line the name always fits. */}
      <header style={{ margin: "18px 0 8px" }}>
        <button
          className="btn-plain row"
          style={{ gap: 8, minHeight: 44 }}
          onClick={() => setSwitching(true)}
          title="Not you? Tap to switch"
        >
          <h1 className="name" style={{ margin: 0 }}>{me.name}</h1>
          <span className="pill muted">switch</span>
        </button>
        <div className="row" style={{ marginTop: 2 }}>
          {data?.team ? (
            // Team colours are organizer-editable, so the label colour is derived
            // from the swatch rather than assumed to be white.
            <span
              className="pill pill-wrap"
              style={{
                background: data.team.color,
                color: inkOn(data.team.color),
                borderColor: data.team.color,
              }}
            >
              {data.team.name}
            </span>
          ) : data ? (
            <span className="pill pill-warn">no team</span>
          ) : (
            // Before the first poll lands `data` is null, which is not the same as
            // "not on a team". Warning here would tell every player they were
            // unrostered for as long as the request takes.
            <span className="pill muted">…</span>
          )}
          <span className="muted tiny push">R{data?.settings.round ?? "–"}</span>
        </div>
      </header>

      {switching && (
        <div className="card card-accent">
          <b>You&apos;re submitting as {me.name}</b>
          <p className="muted tiny" style={{ margin: "4px 0 10px" }}>
            {s && s.submitted > 0
              ? `${s.submitted} submission${s.submitted === 1 ? "" : "s"} already went in under this name. Switching won't move those — ask an organizer if any of them are on the wrong team.`
              : "Nothing has been submitted under this name yet, so switching is clean."}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-sm btn-primary"
              style={{ flex: 1 }}
              onClick={() => {
                setMe(null);
                router.replace("/");
              }}
            >
              Pick a different name
            </button>
            <button className="btn btn-sm" onClick={() => setSwitching(false)}>
              Stay
            </button>
          </div>
        </div>
      )}

      {error && <div className="card card-bad tiny bad">Connection hiccup — retrying. ({error})</div>}

      {data && !data.team && (
        <div className="card card-bad">
          <b className="warn">You&apos;re not on a Round {data.settings.round} team yet.</b>
          <p className="muted tiny" style={{ margin: "6px 0 0" }}>
            Grab an organizer. Until then your submissions can&apos;t be scored, so don&apos;t
            upload anything.
          </p>
        </div>
      )}

      {closed && (
        <div className="card card-bad">
          <b className="warn">Submissions are closed right now.</b>
        </div>
      )}

      {s && (
        <div className="card row" style={{ gap: 14, justifyContent: "space-between" }}>
          <Stat label="points" value={s.points} big />
          <Stat label="scored" value={s.approved} />
          <Stat label="waiting" value={s.pending} />
          {s.rejected > 0 && <Stat label="rejected" value={s.rejected} />}
        </div>
      )}

      {/* A rejected team that isn't told has simply lost those points -- they
          will never know to redo it. This sits above the task list until the
          task gets an approved submission, at which point it disappears on its
          own. Tapping jumps to the task so the retry is one action. */}
      {(data?.rejections ?? []).length > 0 && (
        <div className="card card-bad">
          <b className="bad">
            {data!.rejections.length} rejected — redo {data!.rejections.length === 1 ? "it" : "them"}{" "}
            to get the points
          </b>
          <div className="stack" style={{ marginTop: 10 }}>
            {data!.rejections.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8 }}>
                <div className="grow">
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{r.taskTitle}</div>
                  <div className="muted tiny">{r.reason || "No reason given"}</div>
                </div>
                <button
                  className="btn btn-sm"
                  disabled={uploadBlocked}
                  onClick={() => {
                    const task = data?.tasks.find((x) => x.id === r.taskId);
                    if (task) pickFor(task);
                  }}
                >
                  Retry
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Normally the upload card renders inside the task it belongs to, right
          under the button that was tapped. This is the fallback for when that
          task is not on screen at all -- filtered out by a search or a tier
          chip, or cut by an organizer mid-upload -- because a card with the
          note box on it must never be somewhere the player cannot find it. */}
      {job && !jobIsListed && (
        <JobCard
          job={job}
          showTitle
          onClose={() => setJob(null)}
          onCancel={cancelUpload}
          onAddAnother={() =>
            pickFor(job.task, job.anchorId ? { anchorId: job.anchorId, note: job.note } : undefined)
          }
          addAnotherBlocked={uploadBlocked}
        />
      )}

      <input
        className="field"
        placeholder="Search tasks"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoComplete="off"
        style={{ margin: "6px 0 8px" }}
      />

      {/* Four buckets, always out in the open once there is anything to sort
          into them. A segmented control rather than chips because exactly one
          is ever in effect -- the same idiom the feed and the round switcher
          use -- and full width so four labels cannot overflow a narrow phone
          sideways. */}
      {showStatus && (
        <div className="seg seg-full status-filter" style={{ margin: "0 0 6px" }}>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={status === f.key ? "on" : ""}
              aria-pressed={status === f.key}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* The points and saved filters fold away, because four stacked controls
          above a fifty-row list leaves almost no list. The button names what is
          folded rather than merely marking that something is: a filter you
          cannot see and cannot name is the strand shape all over again. */}
      {(showTiers || showSaved) && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "0 0 6px" }}>
          <button
            className={`btn btn-sm filters-toggle${foldedFilters.length > 0 ? " is-on" : ""}`}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            {foldedFilters.length > 0
              ? `Filters · ${foldedFilters.join(" · ")}`
              : filtersOpen
                ? "Filters ▴"
                : "Filters ▾"}
          </button>
          {foldedFilters.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => {
                setTier(null);
                setOnlySaved(false);
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Points chips, above the saved filter because on a list this long the
          usual question is "what's still worth 10" rather than "what did I
          star". Rendered whenever there is more than one tier to choose
          between -- and whenever one is chosen, even if the round has since
          shrunk to a single tier, so the control that set the filter can never
          disappear while the filter is still on. */}
      {filtersOpen && showTiers && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", margin: "0 0 4px" }}>
          <button
            className={`btn btn-sm tier-filter${tier === null ? " is-on" : ""}`}
            aria-pressed={tier === null}
            onClick={() => setTier(null)}
          >
            All
          </button>
          {tiers.map((p) => (
            <button
              key={p}
              className={`btn btn-sm tier-filter${tier === p ? " is-on" : ""}`}
              aria-pressed={tier === p}
              onClick={() => setTier((v) => (v === p ? null : p))}
            >
              {p} pt{p === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      )}

      {/* Stays inside the fold whenever the filter is ON, even at zero saved
          tasks. Hiding it at that moment would take away the only control that
          undoes it and leave the player staring at an empty list. It only
          disappears when there is nothing saved AND the filter is already off,
          where there is no state to strand. */}
      {filtersOpen && showSaved && (
        <div className="row" style={{ margin: "0 0 4px" }}>
          <button
            className={`btn btn-sm saved-filter${onlySaved ? " is-on" : ""}`}
            aria-pressed={onlySaved}
            onClick={() => setOnlySaved((v) => !v)}
          >
            ★ Saved · {savedShown}
          </button>
          {onlySaved && <span className="muted tiny">showing saved only</span>}
        </div>
      )}

      {/* The status filter takes precedence over the other two empty states.
          It is the coarsest cut and the one most likely to be the real cause,
          and letting the others speak first produced the wrong answer outright:
          filtered to Rejected with a 10-point chip on, the points empty state
          announced that nothing is worth 10 points any more while the round was
          full of them. */}
      {data && grouped.length === 0 && status !== "all" && (
        <div className="empty">
          <b>
            {blameOtherFilters
              ? `No ${STATUS_EMPTY[status].noun} tasks match your other filters`
              : STATUS_EMPTY[status].title}
          </b>
          {blameOtherFilters
            ? `${alsoNarrowing.join(" and ")} ${alsoNarrowing.length === 1 ? "is" : "are"} narrowing it too.`
            : STATUS_EMPTY[status].body}
          <div>
            <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={clearFilters}>
              Show all tasks
            </button>
          </div>
        </div>
      )}

      {data && grouped.length === 0 && status === "all" && onlySaved && (
        <div className="empty">
          {/* Three different truths, and saying the wrong one is its own small
              bug: after the remix a player who saved five Round 1 tasks has a
              full shortlist and an empty round, which is not "nothing saved".
              saved.size is what they stored; savedInRound is what survives
              into this round's list. */}
          <b>
            {saved.size === 0
              ? "Nothing saved yet"
              : savedInRound === 0
                ? "None of your saved tasks are in this round"
                : savedNarrowedBy === "tier"
                  ? `None of your saved tasks are worth ${tier} point${tier === 1 ? "" : "s"}`
                  : savedNarrowedBy === "both"
                    ? "No saved tasks match those filters"
                    : "No saved tasks match that search"}
          </b>
          {saved.size === 0
            ? "Tap ☆ on any task to keep it here for later."
            : savedInRound === 0
              ? "This half of the hunt has its own task list — star the ones you want from it."
              : savedNarrowedBy === "tier"
                ? "Clear the points filter to see the rest of your saved tasks."
                : savedNarrowedBy === "both"
                  ? "Clear the points filter or the search to see the rest of your saved tasks."
                  : "Clear the search to see the rest of your saved tasks."}
          <div>
            <button
              className="btn btn-sm"
              style={{ marginTop: 12 }}
              onClick={clearFilters}
            >
              Show all tasks
            </button>
          </div>
        </div>
      )}

      {data && grouped.length === 0 && status === "all" && !onlySaved && (
        <div className="empty">
          <b>No tasks match</b>
          {/* Three causes, and only one of them is the search box. A player
              filtered to a tier an organizer has just cut every task out of has
              typed nothing, and telling them to shorten a search they never
              made sends them hunting for the wrong thing.

              None of these name a control any more: the points chips fold away,
              so "tap All" was an instruction to tap something that may not be
              on the screen. The escape below is always there instead. */}
          {tier === null
            ? "Try a shorter search."
            : q.trim()
              ? "Try a shorter search, or look at every points tier."
              : `Nothing is worth ${tier} point${tier === 1 ? "" : "s"} in this round any more.`}
          <div>
            <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={clearFilters}>
              Show all tasks
            </button>
          </div>
        </div>
      )}

      {grouped.map(([points, list]) => (
        <section key={points}>
          <h2 className="eyebrow tier-head">
            {points} point{points === 1 ? "" : "s"}
          </h2>
          <div className="stack">
            {list.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                subs={byTask.get(t.id) ?? []}
                job={job?.task.id === t.id ? job : null}
                onJobClose={() => setJob(null)}
                onJobCancel={cancelUpload}
                disabled={uploadBlocked}
                playerId={me.id}
                saved={saved.has(t.id)}
                onToggleSaved={() => toggleSaved(t.id)}
                onPick={() => pickFor(t)}
                onAddTo={(anchorId, note) => pickFor(t, { anchorId, note })}
                onChanged={reload}
              />
            ))}
          </div>
        </section>
      ))}

    </>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div>
      <div className={big ? "stat-value big" : "stat-value"}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function TaskRow({
  task,
  subs,
  job,
  onJobClose,
  onJobCancel,
  disabled,
  playerId,
  saved,
  onToggleSaved,
  onPick,
  onAddTo,
  onChanged,
}: {
  task: Task;
  subs: Sub[];
  /** The upload in flight for THIS task, if there is one. */
  job: Job | null;
  onJobClose: () => void;
  onJobCancel: () => void;
  disabled: boolean;
  playerId: string;
  saved: boolean;
  onToggleSaved: () => void;
  onPick: () => void;
  onAddTo: (anchorId: string, note: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const { data: otherData, error: otherError } = usePoll<OtherTeamEntries>(
    otherOpen
      ? `/api/task-entries?taskId=${encodeURIComponent(task.id)}&playerId=${encodeURIComponent(playerId)}`
      : null,
    8000
  );
  const approved = subs
    .filter((s) => s.status === "approved")
    .sort((a, b) =>
      `${b.judged_at ?? ""}|${b.created_at}|${b.id}`.localeCompare(
        `${a.judged_at ?? ""}|${a.created_at}|${a.id}`
      )
    )[0];
  const rejected = subs.find((s) => s.status === "rejected");
  /* The one place the card's colour, its pill and the chip row above it agree.
     Two of the three used to be written out inline, and a list where a green
     card sits under a chip row reading "To do" is worse than no filter. */
  const st = statusOf(subs);

  /* An "uploading" row has a path reserved but no bytes in Storage yet, so its
     URL would 404. Everything else is viewable. Newest first, matching the
     order the server sends. */
  const viewable = subs.filter((s) => s.status !== "uploading");
  // Several files sent as one piece of evidence are one thing to look at, and
  // one thing the judge will decide. Counting groups rather than files keeps
  // "See 2" meaning two submissions rather than two photos of the same moment.
  const groups = useMemo(
    () =>
      // Oldest file first WITHIN a group, so the player sees the set in the same
      // order the judge did. The list itself stays newest-group-first, which is
      // the order the server sends.
      groupBy(viewable, (s) => s.groupId).map((files) =>
        [...files].sort((a, b) => a.created_at.localeCompare(b.created_at))
      ),
    [viewable]
  );

  /* Green scored, amber with the judge, red needs redoing. Amber is the one
     that had to be added: on a list of green and red cards an untinted card
     reads as untouched, so a task already sent and waiting looked like work
     still to do -- and the "waiting on judge" line explaining otherwise was
     inside a card that gave every other signal that it was not. */
  const tint =
    st === "done" ? " card-done" : st === "waiting" ? " card-wait" : st === "rejected" ? " card-fail" : "";

  return (
    <div className={`card card-flat${tint}`}>
      <div className="task-content">
        <div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="grow" style={{ fontWeight: 600, lineHeight: 1.35 }}>
              {task.title}
            </div>
            {/* Sits on the title line rather than in the action row below: on a
                list this long it gets tapped far more often than Upload, and it
                must not push the real actions around as titles wrap. */}
            <button
              className={`btn btn-sm btn-star${saved ? " is-on" : ""}`}
              aria-label="Save for later"
              aria-pressed={saved}
              onClick={onToggleSaved}
            >
              {saved ? "★" : "☆"}
            </button>
          </div>
          <div className="row" style={{ gap: 6, marginTop: 7, flexWrap: "wrap" }}>
            {/* First, and on every card. The tier headings answer "where am I"
                while scrolling, but once a card is the one being read -- or
                reached from the rejected list, or a search -- what it is worth
                has to be on the card itself. Solid because it is the one thing
                on this row that is true of every task, matching how /judge
                already shows the same number to the organizer. */}
            <span className="pill pill-solid">
              {task.points} pt{task.points === 1 ? "" : "s"}
            </span>
            {task.requires_video && <span className="pill">video only</span>}
            {task.scoring_mode === "quantity" && (
              /* The unit is stored as a singular phrase ("extra pigeon"), so the
                 rate reads as a sentence without the task title having to spell
                 it out a second time. */
              <span className="pill pill-accent pill-wrap">
                +{task.points_per_unit} pt{task.points_per_unit === 1 ? "" : "s"} per{" "}
                {task.measurement_label || "extra item"}
              </span>
            )}
            {task.scoring_mode === "competition" && (
              <span className="pill pill-warn pill-wrap">
                best one wins +{task.competition_bonus} at the end of the round
              </span>
            )}
            {/* Just the word: the points pill beside it already carries the
                number this used to have to spell out on its own. */}
            {task.is_secret && <span className="pill pill-warn">secret</span>}
            {task.competition && (
              <span className="pill pill-wrap">
                {task.competition.team} won +{task.competition.bonus}
              </span>
            )}
            {st === "done" && approved && (
              <Score
                base={approved.basePoints ?? approved.points_awarded ?? 0}
                bonus={approved.bonusPoints}
                tone="pill-good"
                check
              />
            )}
            {st === "waiting" && <span className="pill pill-warn">waiting on judge</span>}
            {st === "rejected" && rejected && (
              <span className="pill pill-bad pill-wrap">
                ✗ {rejected.reject_reason || "rejected"}
              </span>
            )}
          </div>
        </div>
        {/* Keep all task wording readable before presenting the controls. The
            long "other teams" action gets its own wrapped line, while shorter
            actions can share the row below it. */}
        <div className="row task-actions" style={{ gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          <button
            className="btn btn-sm"
            style={{ flex: "1 1 120px" }}
            disabled={disabled}
            onClick={onPick}
          >
            {st === "done" || st === "waiting" ? "Redo" : "Upload"}
          </button>
          {groups.length > 0 && (
            <button
              className="btn btn-sm"
              style={{ flex: "1 1 120px" }}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Hide" : groups.length > 1 ? `See ${groups.length}` : "See"}
            </button>
          )}
          <button
            className="btn btn-sm"
            style={{ flex: "1 1 100%" }}
            onClick={() => setOtherOpen((v) => !v)}
            aria-expanded={otherOpen}
          >
            {otherOpen ? "Hide other teams" : "See other teams' entries"}
          </button>
        </div>
      </div>

      {/* The upload lands here rather than at the top of the page. It used to
          render above the search box, which on a list this long meant tapping
          Upload on a task far down showed the player nothing at all -- and the
          note box lives on that card, so a note "could only be added after
          uploading" when in fact it was live the whole time, just off screen. */}
      {job && (
        <JobCard
          job={job}
          onClose={onJobClose}
          onCancel={onJobCancel}
          onAddAnother={() => job.anchorId && onAddTo(job.anchorId, job.note)}
          addAnotherBlocked={disabled}
        />
      )}

      {open && (
        <div className="stack" style={{ marginTop: 12 }}>
          {groups.map((files) => (
            <SubmissionView
              key={files[0].groupId}
              files={files}
              mine={files[0].player_id === playerId}
              disabled={disabled}
              onAddTo={onAddTo}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {otherOpen && (
        <div className="card card-flat" style={{ marginTop: 12, background: "var(--line-soft)" }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <b>Other teams&apos; entries</b>
            {otherData && (
              <span className="muted tiny push">
                {otherData.entries.length} scored
              </span>
            )}
          </div>
          {otherError && <div className="card card-bad tiny bad">{otherError}</div>}
          {!otherData && !otherError && <p className="muted tiny">Loading…</p>}
          {otherData && otherData.entries.length === 0 && (
            <div className="empty" style={{ margin: 0, padding: "18px 10px" }}>
              <b>No other team has scored this task yet</b>
              Keep moving.
            </div>
          )}
          {otherData?.entries.map((entry) => (
            <EvidenceEntryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the team's submissions for a task: what was sent, by whom, and where
    it got to. Rendered only while expanded, so nothing downloads until asked.

    "One" can be several files -- a photo and the clip that explains it -- which
    the judge sees and decides together. They are laid out one under another
    rather than in a carousel: a carousel hides evidence behind a gesture, and
    the person reviewing this has already told us they want to look. */
function SubmissionView({
  files,
  mine,
  disabled,
  onAddTo,
  onChanged,
}: {
  files: Sub[];
  mine: boolean;
  disabled: boolean;
  onAddTo: (anchorId: string, note: string) => void;
  onChanged: () => void;
}) {
  const sub = files[0];
  const waiting = sub.status === "pending" || sub.status === "uploading";
  // Read off whichever file carries it rather than off the first, so the note
  // survives a member that predates it -- the same rule the judge screen and
  // the feed follow.
  const groupNote = files.find((f) => f.note)?.note ?? null;

  return (
    <div>
      <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <span className="name tiny muted">{mine ? "you" : sub.playerName}</span>
        {files.length > 1 && (
          <span className="pill">
            {files.length} files
          </span>
        )}
        {sub.status === "approved" ? (
          <Score
            base={sub.basePoints ?? sub.points_awarded ?? 0}
            bonus={sub.bonusPoints}
            tone="pill-good"
            check
            push
          />
        ) : (
          <span
            className={`pill pill-wrap push ${sub.status === "rejected" ? "pill-bad" : "pill-warn"}`}
          >
            {sub.status === "rejected" ? `✗ ${sub.reject_reason || "rejected"}` : "waiting on judge"}
          </span>
        )}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {files.map((f) => (
          <div className="media-box" key={f.id}>
            {f.isVideo ? (
              /* Same iOS rule as the feed: preload="auto" and the #t=0.1
                 fragment, or Safari renders an untappable black box. */
              <video className="media" controls playsInline preload="auto" src={`${f.mediaUrl}#t=0.1`} />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="media" src={f.mediaUrl} alt="Your submission" />
            )}
          </div>
        ))}
      </div>

      {/* Still waiting means the note can still change the judge's mind, so it
          stays editable. Once judged it is shown as it was, because a caption
          rewritten under a decision is something the judge never saw. */}
      {waiting ? (
        <NoteEditor submissionId={sub.id} initial={groupNote ?? ""} onSaved={onChanged} />
      ) : (
        groupNote && (
          <p className="tiny muted" style={{ margin: "8px 0 0", overflowWrap: "anywhere" }}>
            “{groupNote}”
          </p>
        )
      )}

      {waiting && (
        <button
          className="btn btn-sm"
          style={{ marginTop: 8 }}
          disabled={disabled}
          onClick={() => onAddTo(sub.id, groupNote ?? "")}
        >
          Add another file to this
        </button>
      )}
    </div>
  );
}

/**
 * The player's own note on a submission: what the judge is looking at.
 *
 * Saved on blur rather than behind a Save button, because the realistic ending
 * to typing a note on a phone mid-scavenger-hunt is putting the phone away, not
 * tapping one more control. Blur fires before the click that dismisses the card,
 * so tapping OK saves too. The state line exists so a save that fails is
 * visible: silently losing the note would be worse than not offering one.
 */
function NoteEditor({
  submissionId,
  initial,
  onSaved,
}: {
  submissionId: string;
  initial: string;
  onSaved?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // What the server is known to hold. Compared against on every blur so
  // re-blurring an unchanged box doesn't fire a pointless write.
  const stored = useRef(initial);

  const save = async () => {
    const value = text.trim();
    if (value === stored.current) return;
    setState("saving");
    try {
      await api(`/api/submissions/${submissionId}`, {
        method: "PATCH",
        body: JSON.stringify({ noteOnly: true, note: value }),
      });
      stored.current = value;
      setState("saved");
      onSaved?.();
    } catch {
      setState("error");
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        className="field"
        rows={2}
        maxLength={NOTE_MAX}
        placeholder="Add a note for the judge (optional)"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
        }}
        onBlur={save}
        style={{ resize: "none" }}
      />
      <div className="row" style={{ marginTop: 4 }}>
        <span className="tiny muted grow">
          {state === "saving" && "Saving…"}
          {state === "saved" && "Note saved."}
          {state === "error" && <span className="bad">Couldn&apos;t save that note.</span>}
        </span>
        {state === "error" && (
          <button className="btn btn-sm" onClick={save}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * What is being sent, while it is being sent.
 *
 * The file is shown from a local object URL and the note box is live from the
 * moment the row is reserved, so "look at it, say what it is, done" all happen
 * during the upload rather than after it. Nothing waits on a Submit tap: an
 * upload that has already started cannot be lost by a player who puts their
 * phone in a pocket, and that matters more here than a confirmation step does.
 */
function JobCard({
  job,
  showTitle = false,
  onClose,
  onCancel,
  onAddAnother,
  addAnotherBlocked,
}: {
  job: Job;
  /** Only when the card is stranded away from its task. Inside the task's own
      card the title is directly above it already. */
  showTitle?: boolean;
  onClose: () => void;
  onCancel: () => void;
  onAddAnother: () => void;
  addAnotherBlocked: boolean;
}) {
  const card = useRef<HTMLDivElement>(null);
  const tone =
    job.status === "error" ? "card-bad" : job.status === "done" ? "card-good" : "card-accent";

  /* Brought into view once per picked file. Centred rather than merely made
     visible: this card is tall enough that "scroll until its top edge shows"
     leaves the note box below the fold, which is the exact problem it exists to
     fix. It also covers the case of a card reached from the rejected list at the
     top of the page, whose task can be hundreds of pixels down -- without this
     the player taps Retry and sees nothing happen at all. */
  useEffect(() => {
    card.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [job.startedAt]);

  return (
    <div className={`card ${tone}`} ref={card} style={{ marginTop: 12 }}>
      {showTitle && <div style={{ fontWeight: 700, lineHeight: 1.3 }}>{job.task.title}</div>}
      <div className="muted tiny" style={{ marginBottom: 10 }}>
        {job.fileName} · {fmtBytes(job.size)}
        {job.retries > 0 && ` · retry ${job.retries}`}
      </div>

      {/* Checked before it is judged: the wrong clip out of a camera roll is the
          realistic mistake, and it is far cheaper to spot here than to have a
          judge reject it twenty minutes later. */}
      {job.preview && (
        <div className="media-box media-preview" style={{ marginBottom: 10 }}>
          {job.preview.isVideo ? (
            /* Same iOS rule as everywhere else: preload="auto" and the #t=0.1
               fragment, or Safari renders an untappable black box. */
            <video
              className="media"
              controls
              playsInline
              preload="auto"
              src={`${job.preview.url}#t=0.1`}
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="media" src={job.preview.url} alt="What you're sending" />
          )}
        </div>
      )}

      {job.status === "uploading" && (
        <>
          <div className="bar">
            <i style={{ width: `${job.pct}%` }} />
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span className="tiny muted grow">
              <b className="num">{job.pct}%</b> — keep this screen open
            </span>
            <button className="btn btn-sm" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}

      {job.status === "done" && (
        <div className="row">
          <b className="good grow">Sent. It&apos;s in the judge&apos;s queue.</b>
          <button className="btn btn-sm" onClick={onClose}>
            OK
          </button>
        </div>
      )}

      {job.status === "error" && (
        <div>
          <b className="bad">Didn&apos;t send.</b>
          <p className="tiny" style={{ margin: "4px 0 10px" }}>
            {job.message}
          </p>
          <p className="tiny muted" style={{ margin: "0 0 10px" }}>
            Your photo is still on your phone. Try again, or text it to an organizer.
          </p>
          <button className="btn btn-sm" onClick={onClose}>
            Dismiss
          </button>
        </div>
      )}

      {/* The note goes here, next to the progress bar, because the upload is
          dead time the player is already spending looking at this card. The row
          exists from the moment it is reserved, so this is live before the bytes
          have finished moving. */}
      {job.anchorId && job.status !== "error" && (
        <NoteEditor key={job.anchorId} submissionId={job.anchorId} initial={job.note} />
      )}

      {/* Some tasks need two photos, or a photo and the clip that explains it.
          Adding one at a time reuses the upload path exactly as it is rather
          than introducing a batch, and a file that fails still leaves the ones
          before it safely in the queue. */}
      {job.anchorId && job.status !== "uploading" && (
        <button
          className="btn btn-sm btn-wide"
          style={{ marginTop: 8 }}
          disabled={addAnotherBlocked}
          onClick={onAddAnother}
        >
          Add another photo or clip to this
        </button>
      )}
    </div>
  );
}
