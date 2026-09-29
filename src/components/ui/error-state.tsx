import Link from "next/link";
import {
  CloudOff,
  FileQuestion,
  LockKeyhole,
  SearchX,
  ServerCrash,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

/**
 * Error-state system. Only customer-safe copy is ever rendered; technical
 * detail stays in logs. Every variant ships sensible recovery actions.
 */

export type ErrorKind = "network" | "api" | "invalid" | "unauthorized" | "notfound" | "server";

const copy: Record<ErrorKind, { icon: LucideIcon; title: string; description: string }> = {
  network: {
    icon: WifiOff,
    title: "You're offline",
    description: "We couldn't reach the server. Check your connection and try again.",
  },
  api: {
    icon: CloudOff,
    title: "Service hiccup",
    description: "One of our services didn't respond in time. Please retry in a moment.",
  },
  invalid: {
    icon: FileQuestion,
    title: "Check the details",
    description: "Some information didn't pass validation. Review the fields and submit again.",
  },
  unauthorized: {
    icon: LockKeyhole,
    title: "Sign-in required",
    description: "That page needs an account. Sign in to continue where you left off.",
  },
  notfound: {
    icon: SearchX,
    title: "Nothing here",
    description: "We couldn't find what you were looking for — it may have moved or sold out.",
  },
  server: {
    icon: ServerCrash,
    title: "Something went wrong",
    description: "That's on us. The team has been notified — please try again shortly.",
  },
};

export interface ErrorStateProps {
  kind: ErrorKind;
  title?: string;
  description?: string;
  onRetry?: () => void;
  /** Extra recovery actions (e.g. "Continue shopping"). */
  children?: ReactNode;
  className?: string;
}

export function ErrorState({ kind, title, description, onRetry, children, className }: ErrorStateProps) {
  const preset = copy[kind];
  const Icon = preset.icon;

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-4 rounded-panel border-[1.5px] border-clay bg-cream/40 px-6 py-14 text-center",
        className,
      )}
    >
      <span className="flex size-14 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper" aria-hidden>
        <Icon className="size-6 text-danger" />
      </span>
      <div className="space-y-1.5">
        <h3 className="font-display text-xl font-bold uppercase tracking-tight">
          {title ?? preset.title}
        </h3>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-smoke">
          {description ?? preset.description}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {onRetry ? (
          <Button variant="primary" size="md" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        <Button asChild variant="outline" size="md">
          <Link href="/">Go home</Link>
        </Button>
        <Button asChild variant="ghost" size="md">
          <a href={`mailto:${siteConfig.contact.supportEmail}`}>Contact support</a>
        </Button>
        {children}
      </div>
    </div>
  );
}
