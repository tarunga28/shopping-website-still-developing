import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { DeactivateAccountCard, ExportDataCard } from "@/components/account/settings-privacy";
import { PreferencesForm } from "@/components/account/preferences-form";
import { loadAccountContext } from "@/server/account-context";
import { getPreferences } from "@/services/preferences.service";

export default async function SettingsPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const preferences = await getPreferences(context.user.id);

  return (
    <AccountShell
      title="Settings"
      description="Notifications, language, privacy and account lifecycle."
      active="settings"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <div className="max-w-2xl space-y-6">
        <PreferencesForm initial={preferences} />
        <ExportDataCard />
        <DeactivateAccountCard role={context.user.role} />
      </div>
    </AccountShell>
  );
}
