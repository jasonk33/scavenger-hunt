"use client";

import { usePoll } from "@/lib/client";

type NoticeResponse = { notice?: string };

export default function Notice() {
  const { data } = usePoll<NoticeResponse>("/api/notice", 15000);
  const text = data?.notice ?? "";

  if (!text) return null;

  return (
    <div className="notice">
      <span className="notice-dot" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}
