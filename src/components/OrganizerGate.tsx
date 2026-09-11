"use client";

import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, errorMessage } from "@/lib/client";

export default function OrganizerGate({
  endpoint, description, children,
}: {
  endpoint: string;
  description: string;
  children: ReactNode;
}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api(endpoint, { signal: controller.signal })
      .then(() => { if (!controller.signal.aborted) setAuthed(true); })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // Only a PIN refusal means locked. An outage must offer recovery,
        // rather than sending an already-unlocked organizer back to login.
        if (e instanceof ApiError && e.status === 401) setAuthed(false);
        else setError(errorMessage(e, "Could not reach the organizer screen."));
      });
    return () => controller.abort();
  }, [endpoint, attempt]);

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setPinError("");
    try {
      await api("/api/admin/login", { method: "POST", body: JSON.stringify({ pin }) });
      setAuthed(true);
    } catch (e) {
      setPinError(errorMessage(e, "Could not unlock."));
    } finally {
      setBusy(false);
    }
  };

  if (authed) return children;
  if (error) {
    return (
      <div className="card card-bad" role="alert">
        Couldn&apos;t check organizer access: {error}
        <button className="btn btn-sm" style={{ display: "flex", marginTop: 8 }} onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (authed === null) return <p className="muted" style={{ marginTop: 24 }}>Checking…</p>;

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h2 style={{ margin: "0 0 2px" }}>Organizer</h2>
      <p className="muted tiny" style={{ margin: "0 0 12px" }}>{description}</p>
      <input
        className="field"
        type="password"
        inputMode="numeric"
        placeholder="PIN"
        aria-label="PIN"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void login()}
        style={{ marginBottom: 10 }}
      />
      {pinError && <p className="bad tiny" role="alert">{pinError}</p>}
      <button className="btn btn-primary btn-wide" disabled={busy} onClick={() => void login()}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>
    </div>
  );
}
