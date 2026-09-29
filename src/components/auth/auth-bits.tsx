import { LockKeyhole, ShieldCheck } from "lucide-react";

/** Small shared trust bits used across auth pages. */
export function AuthenticatorBanner() {
  return (
    <div className="rounded-card border-[1.5px] border-clay bg-cream/70 px-5 py-4">
      <p className="flex items-center gap-2 text-xs font-semibold text-ink">
        <ShieldCheck className="size-4 text-success" aria-hidden />
        Your credentials never leave the server in plain text.
      </p>
      <p className="mt-1.5 flex items-start gap-2 text-[11px] leading-relaxed text-smoke">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Passwords are hashed with scrypt before storage, sessions use secure
        HTTP-only cookies, and sensitive actions are rate-limited.
      </p>
    </div>
  );
}

/** Generic auth page footer link row. */
export function AuthSwitch({ prompt, href, label }: { prompt: string; href: string; label: string }) {
  return (
    <p className="text-center text-sm text-smoke">
      {prompt}{" "}
      <a
        href={href}
        className="font-semibold text-ink underline decoration-flame decoration-2 underline-offset-4 hover:text-flame"
      >
        {label}
      </a>
    </p>
  );
}
