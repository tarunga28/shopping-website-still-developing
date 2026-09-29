import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { AvatarManager } from "@/components/account/avatar-manager";
import { EmailChangeCard } from "@/components/account/email-change-card";
import { ProfileForm } from "@/components/account/profile-form";
import { loadAccountContext } from "@/server/account-context";

export default async function ProfilePage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const { user } = context;

  return (
    <AccountShell
      title="Profile"
      description="Your identity, photo and sign-in email."
      active="profile"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-2xl space-y-6">
        <AvatarManager name={user.name} avatarUrl={user.avatarUrl} />
        <ProfileForm defaultName={user.name} defaultPhone={user.phone ?? ""} />
        <EmailChangeCard
          email={user.email}
          verified={Boolean(user.emailVerifiedAt)}
          pendingEmail={user.pendingEmail}
        />
      </div>
    </AccountShell>
  );
}
