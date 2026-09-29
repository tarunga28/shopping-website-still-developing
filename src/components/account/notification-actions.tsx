"use client";

import { Check, CheckCheck } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";

export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    const result = await markNotificationReadAction(notificationId);
    if (result.ok) router.refresh();
    else notify.error(result.error);
    setPending(false);
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleClick}
      loading={pending}
      aria-label="Mark as read"
      className="px-2"
    >
      <Check className="size-3.5" aria-hidden />
    </Button>
  );
}

export function MarkAllReadButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    const result = await markAllNotificationsReadAction();
    if (result.ok) {
      notify.success("All caught up");
      router.refresh();
    } else {
      notify.error(result.error);
    }
    setPending(false);
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} loading={pending} disabled={disabled}>
      <CheckCheck className="size-3.5" aria-hidden /> Mark all as read
    </Button>
  );
}
