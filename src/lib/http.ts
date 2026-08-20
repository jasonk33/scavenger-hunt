export function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      // Polled endpoints must never be served from a CDN or browser cache, or the
      // leaderboard silently freezes mid-event.
      "cache-control": "no-store, max-age=0",
    },
  });
}

export function fail(message: string, status = 400) {
  return json({ error: message }, status);
}

/** Narrows an unknown thrown value into something safe to show a person. */
export function errorMessage(e: unknown, fallback = "Something went wrong"): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string" && e) return e;
  return fallback;
}

/** Filesystem- and URL-safe fragment, for building organized object paths. */
export function slug(s: string, max = 40): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[\u2018\u2019\u201c\u201d]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .toLowerCase() || "x"
  );
}

/**
 * iPhone .mov files are ISO base media (structurally MP4) carrying H.264/AAC,
 * but Safari labels them video/quicktime -- a type Chrome refuses to play inline,
 * so it DOWNLOADS the file instead of showing it. Relabelling as video/mp4 makes
 * it play everywhere with no transcoding.
 *
 * Without this the judge screen downloads every iPhone video instead of playing
 * it. Verified on real hardware; do not remove.
 */
export function playableType(fileName: string, reportedType: string): string {
  const t = (reportedType || "").toLowerCase();
  if (t === "video/quicktime" || /\.mov$/i.test(fileName)) return "video/mp4";
  return reportedType || "application/octet-stream";
}

export function extOf(fileName: string, contentType: string): string {
  const m = fileName.match(/\.([a-zA-Z0-9]{1,5})$/);
  if (m) return m[1].toLowerCase() === "mov" ? "mp4" : m[1].toLowerCase();
  if (contentType.startsWith("video")) return "mp4";
  if (contentType.startsWith("image")) return "jpg";
  return "bin";
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|avi|mkv|3gp|mpeg|mpg|ogv)$/i;

/**
 * Whether to render an object with <video> or <img>.
 *
 * Cannot rely on media_type alone: some Android file pickers hand over a File
 * with an empty `type`, which gets stored as application/octet-stream. Treating
 * that as an image renders a real video into a broken <img>, and the judge has
 * no way to view the evidence. The object path always carries an extension, so
 * fall back to it.
 */
export function isVideoObject(mediaType: string | null, objectName: string): boolean {
  const t = (mediaType ?? "").toLowerCase();
  if (t.startsWith("video")) return true;
  if (t.startsWith("image")) return false;
  return VIDEO_EXT.test(objectName);
}
