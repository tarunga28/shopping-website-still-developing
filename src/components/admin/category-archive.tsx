"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { archiveCategoryAction } from "@/server/actions/catalog-actions";

export function CategoryArchive({ id, others }: { id: string; others: { id: string; name: string }[] }) {
  const router = useRouter();
  const [reassign, setReassign] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        const result = await archiveCategoryAction(id, reassign);
        setMessage(result.ok ? result.message ?? "Archived." : result.error);
        if (result.ok) router.refresh();
      }}
    >
      <select value={reassign} onChange={(event) => setReassign(event.target.value)} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-xs" aria-label="Move products to">
        <option value="">Move products to…</option>
        {others.map((category) => (
          <option key={category.id} value={category.id}>{category.name}</option>
        ))}
      </select>
      <Button type="submit" size="sm" variant="outline-danger">Archive</Button>
      {message ? <p className="w-full text-xs">{message}</p> : null}
    </form>
  );
}
