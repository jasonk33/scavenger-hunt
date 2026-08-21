export type Settings = {
  active_round: number;
  submissions_open: boolean;
  fallback_url: string;
  event_name: string;
  /** Free-text banner shown on every screen. The organizer's broadcast channel. */
  notice: string;
};
