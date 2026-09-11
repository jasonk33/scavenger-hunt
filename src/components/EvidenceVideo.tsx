"use client";

import { createContext, useContext, useEffect, useId, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

const VideoContext = createContext<{
  activeId: string | null;
  setActiveId: Dispatch<SetStateAction<string | null>>;
} | null>(null);

/** One selection across all expanded evidence on a page, not one per card. */
export function VideoScope({ children }: { children: ReactNode }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  return <VideoContext.Provider value={{ activeId, setActiveId }}>{children}</VideoContext.Provider>;
}

export default function EvidenceVideo({ url }: { url: string }) {
  const selection = useContext(VideoContext);
  const id = useId();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  if (!selection) throw new Error("EvidenceVideo requires VideoScope");
  const { activeId, setActiveId } = selection;
  const open = activeId === id;

  useEffect(() => () => {
    setActiveId((current) => current === id ? null : current);
  }, [id, setActiveId]);

  useEffect(() => {
    const element = video.current;
    if (!open || !element) return;
    const src = `${url}#t=0.1`;
    // Restore after an effect cleanup (including React's development replay).
    if (element.getAttribute("src") !== src) element.setAttribute("src", src);
    return () => {
      // Pausing alone still allows buffering a large, now-hidden clip.
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [open, url]);

  return (
    <>
      {open && (
        <video
          ref={video}
          id={id}
          className="media"
          controls
          playsInline
          preload="auto"
          src={`${url}#t=0.1`}
          onError={() => setFailed(true)}
        />
      )}
      <button
        type="button"
        className={open ? "btn btn-sm video-close" : "video-load"}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setFailed(false);
          setActiveId(open ? null : id);
        }}
      >
        {open ? "Close video" : "View video"}
      </button>
      {open && failed && (
        <div className="video-error tiny" role="alert">
          Couldn&apos;t load this video. Close it and try again.
        </div>
      )}
    </>
  );
}
