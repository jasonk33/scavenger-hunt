/**
 * Hand-written schema types for the Supabase client.
 *
 * Without these the client infers `never` for every table and silently accepts
 * nothing. Written by hand rather than generated so the app has no dependency on
 * the Supabase CLI being installed and linked; keep in sync with
 * supabase/01-schema.sql.
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
  bonus: number;
  starred: boolean;
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
        "id" | "requires_video" | "is_secret" | "revealed_at" | "sort_order" | "active" | "created_at"
      >;
      submissions: Table<
        SubmissionRow,
        | "id"
        | "media_type"
        | "size_bytes"
        | "status"
        | "points_awarded"
        | "bonus"
        | "starred"
        | "reject_reason"
        | "group_id"
        | "note"
        | "created_at"
        | "judged_at"
      >;
      settings: Table<SettingRow, never>;
    };
    Views: {
      team_scores: { Row: TeamScoreRow; Relationships: [] };
    };
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};
