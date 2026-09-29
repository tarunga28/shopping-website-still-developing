"use client";

import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { removeFromWishlistAction } from "@/server/actions/account-actions";
import { notify } from "@/lib/toast";

export function WishlistRemoveButton({ itemId, productName }: { itemId: string; productName: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleRemove() {
    setPending(true);
    const result = await removeFromWishlistAction(itemId);
    if (result.ok) {
      notify.removed(productName);
      router.refresh();
    } else {
      notify.error(result.error);
    }
    setPending(false);
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleRemove} loading={pending} aria-label={`Remove ${productName} from wishlist`}>
      <Trash2 className="size-3.5" aria-hidden /> Remove
    </Button>
  );
}
