"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { storefrontContent, type AnnouncementMessage } from "@/content/storefront";
import { isExternalHref, safeHref } from "@/lib/safe-url";

const dismissListeners = new Set<() => void>();

function subscribeDismissed(listener: () => void) {
  dismissListeners.add(listener);
  return () => dismissListeners.delete(listener);
}

function readDismissed() {
  return window.sessionStorage.getItem("announcement-dismissed") === "true";
}

function dismissAnnouncement() {
  window.sessionStorage.setItem("announcement-dismissed", "true");
  dismissListeners.forEach((listener) => listener());
}

/**
 * Announcement bar. Messages, links and the on/off switch come from
 * storefront content (already filtered by schedule on the server).
 */
export function AnnouncementBar({
  enabled = storefrontContent.announcement.enabled,
  messages,
}: {
  enabled?: boolean;
  messages?: readonly AnnouncementMessage[];
}) {
  const source = messages ?? storefrontContent.announcement.messages;
  const items = source.filter((message) => message.active);
  const dismissed = useSyncExternalStore(subscribeDismissed, readDismissed, () => true);
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || items.length < 2) return;
    const id = window.setInterval(() => setIndex((current) => (current + 1) % items.length), 5000);
    return () => window.clearInterval(id);
  }, [items.length, paused]);

  if (!enabled || dismissed || items.length === 0) return null;

  const current = items[index % items.length];
  if (!current) return null;
  const href = current.href ? safeHref(current.href, "") : "";

  return (
    <div
      role="region"
      aria-label="Announcements"
      className="relative border-b-[1.5px] border-ink bg-ink px-12 py-2 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-paper sm:tracking-[0.2em]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p aria-live="polite">
        <span className="mx-1 text-flame" aria-hidden>
          ✳
        </span>{" "}
        {href ? (
          <Link
            href={href}
            className="underline decoration-flame/70 underline-offset-4 hover:text-flame focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
            {...(isExternalHref(href) ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {current.message}
          </Link>
        ) : (
          current.message
        )}
      </p>
      <button
        type="button"
        aria-label="Dismiss announcement"
        onClick={dismissAnnouncement}
        className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-paper/70 transition-colors hover:bg-paper/10 hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
