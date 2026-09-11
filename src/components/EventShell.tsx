"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePoll } from "@/lib/client";
import type { EventState } from "@/lib/event";

type EventContextValue = {
  data: EventState | null;
  error: string | null;
  reload: () => Promise<void>;
};

const EventContext = createContext<EventContextValue | null>(null);

export function useEvent() {
  const value = useContext(EventContext);
  if (!value) throw new Error("useEvent must be inside EventShell");
  return value;
}

export default function EventShell({ header, children }: { header: ReactNode; children: ReactNode }) {
  const state = usePoll<EventState>("/api/event", 5000);
  const path = usePathname() ?? "/";
  const router = useRouter();
  const taskRoute = path === "/submit" || path.startsWith("/submit/");
  const resultsRoute = ["/leaderboard", "/feed"].some((route) => path === route || path.startsWith(`${route}/`));
  const protectedRoute = taskRoute || resultsRoute;
  const accessible = !protectedRoute || Boolean(state.data &&
    (taskRoute ? state.data.tasksVisible : state.data.startedRound > 0));

  useEffect(() => {
    if (state.data && !accessible) router.replace("/");
  }, [state.data, accessible, router]);

  return (
    <EventContext.Provider value={state}>
      {header}
      <div className="wrap">
        {state.error && (
          <div className="card card-bad tiny" role="alert">
            Couldn&apos;t update event status: {state.error}. Retrying.
            <button className="btn btn-sm" style={{ margin: "8px 0 0", display: "flex" }} onClick={() => void state.reload()}>
              Try again
            </button>
          </div>
        )}
        {accessible ? children : (
          <p className="muted" style={{ marginTop: 24 }}>
            {state.data ? "Returning to Home…" : state.error ? "Waiting for event status." : "Loading event status…"}
          </p>
        )}
      </div>
    </EventContext.Provider>
  );
}
