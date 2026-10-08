"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deactivateBrandAction } from "@/server/actions/catalog-actions";

/**
 * Deactivate a brand.
 *
 * Deactivation rather than deletion: products keep their brand reference, so
 * this cannot orphan catalog history or break a product page mid-edit. The
 * button is hidden entirely for a brand that still has live products, because
 * hiding a populated brand from the storefront silently would mislead a
 * merchandiser into thinking nothing was affected.
 */
export function BrandArchive({ id, productCount }: { id: string; productCount: number }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);

  if (productCount > 0) {
    return (
      <p className="mt-2 text-xs text-smoke">
        {productCount} live product{productCount === 1 ? "" : "s"} use this brand. Move or archive them first.
      </p>
    );
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await deactivateBrandAction(id);
        setMessage(result.ok ? result.message ?? "Deactivated." : result.error);
        if (result.ok) router.refresh();
      }}
    >
      <Button type="submit" size="sm" variant="outline-danger">Deactivate</Button>
      {message ? <p className="w-full text-xs">{message}</p> : null}
    </form>
  );
}
