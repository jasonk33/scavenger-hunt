/**
 * Hand-written schema types for the Supabase client.
 *
 * Without these the client infers `never` for every table and silently accepts
 * nothing. Written by hand rather than generated so the app has no dependency on
 * the Supabase CLI being installed and linked; keep in sync with
 * supabase/setup.sql and the supabase/migrate-*.sql files.
 */

type Timestamp = string;

type TeamRow = {
  id: string;
  round: number;
  name: string;
  color: string;
  sort_order: number;
  created_at: Timestamp;
};

type PlayerRow = { id: string; name: string; created_at: Timestamp };

type RosterRow = { round: number; player_id: string; team_id: string };

type TaskRow = {
  id: string;
  /** Stable id of this task's entry on the planning board, or null for a task added from Admin. */
  board_id: string | null;
  round: number;
  title: string;
  points: number;
  requires_video: boolean;
  is_secret: boolean;
  revealed_at: Timestamp | null;
  sort_order: number;
  active: boolean;
  created_at: Timestamp;
};

/**
 * One task on the planning board.
 *
 * The board is the source of truth for task content, points and cuts, and
 * reaches players only through `scripts/task-sync.mjs`. The app reads it in one
 * place: Admin mirrors an emergency edit back onto it, so the next publish does
 * not silently revert what was just set. Nothing else in the app touches it.
 *
 * Only the columns the app actually uses are listed -- the ratings, prop, note
 * and tier model belong to the canvas, which reads this table through
 * `scripts/board-store.mjs` rather than through this client.
 */
type TaskBoardRow = {
  /** Stable board id (`r1-01`, `s-04`), mirrored onto `tasks.board_id`. */
  board_id: string;
  /** 0 is a secret, offered in both rounds. `tasks.round` only allows 1 and 2. */
  round: number;
  title: string;
  /** Constrained to the 1/3/5/7/10 tiers, unlike `tasks.points`. */
  points: number;
  needs_clip: boolean;
  status: "keep" | "maybe" | "cut";
  updated_at: Timestamp;
};

type SubmissionRow = {
  id: string;
  round: number;
  task_id: string;
  player_id: string;
  team_id: string;
  task_points: number;
  object_name: string;
  media_type: string | null;
  size_bytes: number | null;
  status: "uploading" | "pending" | "approved" | "rejected";
  points_awarded: number | null;
  reject_reason: string | null;
  // Several files that make up one piece of evidence. One row is still one file;
  // this is what the judge reviews and decides as a unit. Nullable because rows
  // created before the column exists have none -- read it as `group_id ?? id`.
  group_id: string | null;
  // Player-written, optional: what the judge is looking at.
  note: string | null;
  created_at: Timestamp;
  judged_at: Timestamp | null;
};

type SettingRow = { key: string; value: string | null };

type TeamScoreRow = {
  team_id: string;
  round: number;
  name: string;
  color: string;
  sort_order: number;
  points: number;
  tasks_scored: number;
};

/** Columns with database defaults are optional on insert. */
type Table<Row, Optional extends keyof Row> = {
  Row: Row;
  Insert: Omit<Row, Optional> & Partial<Pick<Row, Optional>>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      teams: Table<TeamRow, "id" | "sort_order" | "created_at">;
      players: Table<PlayerRow, "id" | "created_at">;
      roster: Table<RosterRow, never>;
      tasks: Table<
        TaskRow,
        "id" | "board_id" | "requires_video" | "is_secret" | "revealed_at" | "sort_order" | "active" | "created_at"
      >;
      submissions: Table<
        SubmissionRow,
        | "id"
        | "media_type"
        | "size_bytes"
        | "status"
        | "points_awarded"
        | "reject_reason"
        | "group_id"
        | "note"
        | "created_at"
        | "judged_at"
      >;
      settings: Table<SettingRow, never>;
      // Only the columns Admin's mirror writes are modelled; the canvas reaches
      // the rest of this table through scripts/board-store.mjs.
      task_board: Table<TaskBoardRow, "round" | "title" | "points" | "needs_clip" | "status" | "updated_at">;
    };
    Views: {
      team_scores: { Row: TeamScoreRow; Relationships: [] };
    };
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
