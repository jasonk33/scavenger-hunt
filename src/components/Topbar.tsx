"use client";

import { useEffect, useRef } from "react";
import Nav from "@/components/Nav";
import Notice from "@/components/Notice";

/**
 * The nav and the broadcast notice, plus the one thing about them that anything
 * else needs to know: how tall they are.
 *
 * Anything else that sticks -- the points headings on /submit -- has to stop
 * below this bar or it slides underneath and is simply invisible. That offset is
 * not a constant: the notice is only sometimes there, and when it is, it wraps to
 * however many lines an organizer typed. Publishing the measured height as
 * `--topbar-h` means a sticky heading stays correct through a notice being set,
 * edited or cleared mid-round, with no magic number to keep in sync.
 */
export default function Topbar() {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const publish = () =>
      document.documentElement.style.setProperty("--topbar-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <header className="topbar" ref={ref}>
      <Nav />
      <Notice />
    </header>
  );
}
