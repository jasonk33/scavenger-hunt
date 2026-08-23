"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import ThemeToggle from "./ThemeToggle";

const PLAYER_LINKS = [
  { href: "/submit", label: "Submit" },
  { href: "/leaderboard", label: "Scores" },
  { href: "/feed", label: "Feed" },
];

export default function Nav() {
  const path = usePathname() ?? "/";
  const [organizer, setOrganizer] = useState(false);

  // The organizer cookie is intentionally readable from JS -- it is a
  // convenience flag, not a credential.
  //
  // Re-checked on a timer rather than only on navigation, because the PIN is
  // entered *on* /judge: without this the organizer unlocks the screen and the
  // nav still shows no Admin link until they navigate somewhere else.
  useEffect(() => {
    const check = () =>
      setOrganizer(document.cookie.split("; ").some((c) => c.startsWith("organizer=")));
    check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, []);

  return (
    <nav className="nav">
      {PLAYER_LINKS.map((l) => (
        <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? "on" : ""}>
          {l.label}
        </Link>
      ))}

      {/* Once unlocked, both organizer screens are listed. Before that there is
          a single "Organizer" entry -- the screens are PIN-gated anyway, and
          hiding them completely meant the only way in was to guess the URL. */}
      {organizer ? (
        <>
          <Link href="/judge" className={path.startsWith("/judge") ? "on" : "organizer"}>
            Judge
          </Link>
          <Link href="/admin" className={path.startsWith("/admin") ? "on" : "organizer"}>
            Admin
          </Link>
        </>
      ) : (
        <Link href="/judge" className="organizer">
          Organizer
        </Link>
      )}

      <ThemeToggle />
    </nav>
  );
}
