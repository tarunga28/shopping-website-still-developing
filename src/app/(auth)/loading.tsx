import { Asterisk } from "lucide-react";

/** Route-level loading shell with brand mark. */
export default function Loading() {
  return (
    <div
      className="flex min-h-[60vh] flex-col items-center justify-center gap-4"
      role="status"
      aria-live="polite"
      aria-label="Loading page"
    >
      <Asterisk className="size-8 animate-[spin_1.6s_linear_infinite] text-flame" aria-hidden />
      <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-smoke">Loading</p>
    </div>
  );
}
