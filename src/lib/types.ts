export type Round = 1 | 2;

export type Team = {
  id: string;
  round: number;
  name: string;
  color: string;
  sort_order: number;
};

export type Player = { id: string; name: string };

export type Task = {
  id: string;
  round: number;
  title: string;
  points: number;
  requires_video: boolean;
  is_secret: boolean;
  revealed_at: string | null;
  sort_order: number;
  active: boolean;
};

export type SubmissionStatus = "uploading" | "pending" | "approved" | "rejected";

export type Submission = {
  id: string;
  round: number;
  task_id: string;
  player_id: string;
  team_id: string;
  task_points: number;
  object_name: string;
  media_type: string | null;
  size_bytes: number | null;
  status: SubmissionStatus;
  points_awarded: number | null;
  bonus: number;
  starred: boolean;
  reject_reason: string | null;
  created_at: string;
  judged_at: string | null;
};

export type Settings = {
  active_round: number;
  submissions_open: boolean;
  fallback_url: string;
  event_name: string;
  /** Free-text banner shown on every screen. The organizer's broadcast channel. */
  notice: string;
};

export type ScoreRow = {
  team_id: string;
  round: number;
  name: string;
  color: string;
  sort_order: number;
  points: number;
  tasks_scored: number;
};
