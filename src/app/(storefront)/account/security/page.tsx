import { BadgeCheck, Clock3, Fingerprint, History, ShieldCheck, Smartphone } from "lucide-react";
import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { Badge } from "@/components/ui/badge";
import { loadAccountContext } from "@/server/account-context";
import { formatDate } from "@/lib/format";

export default async function SecurityPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");
  const { user } = context;

  return (
    <AccountShell
      title="Security"
      description="Keep your account locked down."
      active="security"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-2xl space-y-6">
        {/* Status panel */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-card border-[1.5px] border-clay bg-cream p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-smoke">Account status</p>
            <Badge variant={user.status === "ACTIVE" ? "delivered" : basisBadge(user.status)} className="mt-3">
              {user.status}
            </Badge>
            <p className="mt-2 text-xs text-smoke">Customer since {formatDate(user.createdAt)}</p>
          </div>
          <div className="rounded-card border-[1.5px] border-clay bg-cream p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-smoke">Email verification</p>
            {user.emailVerifiedAt ? (
              <>
                <Badge variant="delivered" className="mt-3">
                  <BadgeCheck className="size-3" aria-hidden /> Verified
                </Badge>
                <p className="mt-2 text-xs text-smoke">on {formatDate(user.emailVerifiedAt)}</p>
              </>
            ) : (
              <>
                <Badge variant="warning" className="mt-3">
                  <Clock3 className="size-3" aria-hidden /> Pending
                </Badge>
                <p className="mt-2 text-xs text-smoke">
                  <a href="/verify-email" className="font-semibold underline decoration-flame decoration-2 underline-offset-2">
                    Resend the link
                  </a>
                </p>
              </>
            )}
          </div>
        </div>

        <ChangePasswordForm />

        {/* Future security architecture — honest roadmap panel */}
        <div className="rounded-card border-[1.5px] border-dashed border-clay bg-cream/40 p-5">
          <h2 className="font-display text-sm font-bold uppercase tracking-tight text-smoke">
            Security roadmap
          </h2>
          <ul className="mt-3 space-y-2.5">
            {[
              { icon: Smartphone, label: "Two-factor authentication (OTP authenticator)" },
              { icon: History, label: "Sign-in history & new-device alerts" },
              { icon: Fingerprint, label: "Passkeys (WebAuthn) sign-in" },
              { icon: ShieldCheck, label: "Active session management — sign out other devices" },
            ].map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-2.5 text-xs text-smoke">
                <Icon className="size-4 shrink-0" aria-hidden />
                {label}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </AccountShell>
  );
}

function basisBadge(status: string): "cancelled" | "soft" {
  return status === "SUSPENDED" ? "cancelled" : "soft";
}
