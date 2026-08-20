"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const PLAYER_LINKS = [
  { href: "/submit", label: "Submit" },
  { href: "/leaderboard", label: "Scores" },
  { href: "/feed", label: "Feed" },
];

const ORGANIZER_LINKS = [
  { href: "/judge", label: "Judge" },
  { href: "/admin", label: "Admin" },
];

export default function Nav() {
  const path = usePathname() ?? "/";
  const [organizer, setOrganizer] = useState(false);

  // The organizer cookie is intentionally readable from JS -- it is a
  // convenience flag, not a credential. Hiding the links just keeps the players'
  // nav bar from advertising a screen they have no reason to open.
  //
  // Re-checked on a timer rather than only on navigation, because the PIN is
  // entered *on* /judge or /admin: without this the organizer unlocks the screen
  // and the nav still has no Judge link until they navigate somewhere. It is a
  // string check against document.cookie, so it costs nothing.
  useEffect(() => {
    const check = () =>
      setOrganizer(document.cookie.split("; ").some((c) => c.startsWith("organizer=")));
    check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, [path]);

  const links = organizer ? [...PLAYER_LINKS, ...ORGANIZER_LINKS] : PLAYER_LINKS;

  return (
    <nav className="nav">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={path.startsWith(l.href) ? "on" : ""}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
