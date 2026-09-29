import { redirect } from "next/navigation";
import { AccountShell } from "@/components/layouts/account-shell";
import { AddressBook } from "@/components/account/address-book";
import { loadAccountContext } from "@/server/account-context";
import { listAddresses } from "@/services/address.service";

export default async function AddressesPage() {
  const context = await loadAccountContext();
  if (!context) redirect("/login");

  const addressList = await listAddresses(context.user.id);

  return (
    <AccountShell
      title="Addresses"
      description="Saved shipping addresses for faster checkout."
      active="addresses"
      identity={context.identity}
      unreadNotifications={context.unreadNotifications}
    >
      <AddressBook initialAddresses={addressList} />
    </AccountShell>
  );
}
