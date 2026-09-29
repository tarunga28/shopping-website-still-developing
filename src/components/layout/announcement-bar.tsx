"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { siteConfig } from "@/config/site";

/**
 * Announcement bar — content is configured in `site.config (announcement)`,
 * never hard-coded in components. Messages rotate gently; the bar can be
 * dismissed per session.
 */
export function AnnouncementBar() {
  const { enabled, messages } = siteConfig.announcement;
  const [dismissed, setDismissed] = useState(true); // avoid flash until hydration check
  const [index, setIndex] = useState(0);

  useEffect(() => {
    // Read after mount to avoid hydration mismatch (canonical pattern).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional post-mount hydration sync
    setDismissed(window.sessionStorage.getItem("announcement-dismissed") === "true");
  }, []);

  useEffect(() => {
    if (messages.length < 2) return;
    const id = window.setInterval(() => setIndex((current) => (current + 1) % messages.length), 5000);
    return () => window.clearInterval(id);
  }, [messages.length]);

  if (!enabled || dismissed) return null;

  return (
    <div
      role="region"
      aria-label="Announcements"
      className="relative border-b-[1.5px] border-ink bg-ink px-10 py-2 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-paper"
    >
      <div aria-live="polite" key={index} className="animate-in fade-in duration-500">
        <span className="mx-1 text-flame" aria-hidden>
          ✳
        </span>{" "}
        {messages[index]}
      </div>
      <button
        type="button"
        aria-label="Dismiss announcement"
        onClick={() => {
          window.sessionStorage.setItem("announcement-dismissed", "true");
          setDismissed(true);
        }}
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-paper/50 transition-colors hover:bg-paper/10 hover:text-paper"
      >
        <X className="size-3" aria-hidden />
      </button>
    </div>
  );
}
