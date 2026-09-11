export type EventPhase = "welcome" | "round1" | "break" | "remix" | "round2" | "finished";

export type EventSettings = {
  active_round: number;
  started_round: number;
  submissions_open: boolean;
};

export type EventState = {
  phase: EventPhase;
  activeRound: number;
  startedRound: number;
  submissionsOpen: boolean;
  tasksVisible: boolean;
};

export function eventState(settings: EventSettings): EventState {
  const activeRound = settings.started_round === 0 ? 1 : settings.active_round;
  const startedRound = Math.min(settings.started_round, activeRound);
  const tasksVisible = startedRound >= activeRound;
  const submissionsOpen = tasksVisible && settings.submissions_open;
  const phase = startedRound === 0 ? "welcome"
    : !tasksVisible ? "remix"
    : activeRound === 1 ? (submissionsOpen ? "round1" : "break")
    : submissionsOpen ? "round2" : "finished";
  return { phase, activeRound, startedRound, submissionsOpen, tasksVisible };
}

const TRANSITIONS: Record<string, { from: EventPhase; settings: EventSettings }> = {
  start_round_1: { from: "welcome", settings: { active_round: 1, started_round: 1, submissions_open: true } },
  end_round_1: { from: "round1", settings: { active_round: 1, started_round: 1, submissions_open: false } },
  reveal_round_2: { from: "break", settings: { active_round: 2, started_round: 1, submissions_open: false } },
  start_round_2: { from: "remix", settings: { active_round: 2, started_round: 2, submissions_open: true } },
  end_round_2: { from: "round2", settings: { active_round: 2, started_round: 2, submissions_open: false } },
  reopen_round_1: { from: "break", settings: { active_round: 1, started_round: 1, submissions_open: true } },
  reopen_round_2: { from: "finished", settings: { active_round: 2, started_round: 2, submissions_open: true } },
};

export function eventTransition(settings: EventSettings, action: string): EventSettings {
  const phase = eventState(settings).phase;
  if (action === "return_to_welcome" && phase !== "welcome") {
    return { active_round: 1, started_round: 0, submissions_open: false };
  }
  const transition = Object.hasOwn(TRANSITIONS, action) ? TRANSITIONS[action] : undefined;
  if (!transition || transition.from !== phase) {
    throw new Error("That action isn't available at this stage. Refresh and try again.");
  }
  return { ...transition.settings };
}
