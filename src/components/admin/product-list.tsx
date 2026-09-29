"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { formatPrice } from "@/lib/format";
import { bulkPhrase } from "@/lib/catalog-rules";
import { bulkCatalogAction } from "@/server/actions/catalog-actions";

export interface AdminListRow {
  id: string;
  name: string;
  slug: string;
  productType: string;
  status: string;
  pricePaise: number;
  categoryName: string | null;
  imageUrl: string | null;
  variantCount: number;
  updatedAt: string;
}

export function ProductAdminList({
  rows,
  categories,
  collections,
}: {
  rows: AdminListRow[];
  categories: { id: string; name: string }[];
  collections: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<"ARCHIVE" | "PUBLISH" | "CHANGE_CATEGORY" | "ADD_COLLECTION" | "REMOVE_COLLECTION">("ARCHIVE");
  const [confirmation, setConfirmation] = useState("");
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const phrase = useMemo(() => (selected.length ? bulkPhrase(action, selected.length) : ""), [action, selected.length]);

  function toggle(id: string, checked: boolean) {
    setSelected((current) => (checked ? [...new Set([...current, id])] : current.filter((item) => item !== id)));
  }

  return (
    <div>
      <form
        className="grid gap-3 rounded-card border-[1.5px] border-clay p-4"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData();
          form.set("action", action);
          form.set("confirmation", confirmation);
          if (categoryId) form.set("categoryId", categoryId);
          if (collectionId) form.set("collectionId", collectionId);
          for (const id of selected) form.append("productIds", id);
          const result = await bulkCatalogAction(null, form);
          setMessage(result.ok ? result.message ?? "Updated." : result.error);
          if (result.ok) router.refresh();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
            Bulk action
            <select value={action} onChange={(event) => setAction(event.target.value as typeof action)} className="h-10 rounded-full border-[1.5px] border-clay bg-white px-3 text-sm font-normal normal-case tracking-normal">
              <option value="ARCHIVE">Archive</option>
              <option value="PUBLISH">Publish</option>
              <option value="CHANGE_CATEGORY">Change category</option>
              <option value="ADD_COLLECTION">Add to collection</option>
              <option value="REMOVE_COLLECTION">Remove from collection</option>
            </select>
          </label>
          {action === "CHANGE_CATEGORY" ? (
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="h-10 rounded-full border-[1.5px] border-clay bg-white px-3 text-sm">
              {categories.map((category) => (
                <option key={category.id} value={category.id}>{category.name}</option>
              ))}
            </select>
          ) : null}
          {action === "ADD_COLLECTION" || action === "REMOVE_COLLECTION" ? (
            <select value={collectionId} onChange={(event) => setCollectionId(event.target.value)} className="h-10 rounded-full border-[1.5px] border-clay bg-white px-3 text-sm">
              {collections.map((collection) => (
                <option key={collection.id} value={collection.id}>{collection.name}</option>
              ))}
            </select>
          ) : null}
          <label className="grid min-w-44 flex-1 gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
            Type {phrase || "a confirmation"}
            <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm font-normal normal-case tracking-normal" />
          </label>
          <Button type="submit" size="sm" disabled={selected.length === 0}>
            Apply to {selected.length}
          </Button>
        </div>
        {message ? <p role="status" className="text-sm">{message}</p> : null}
      </form>

      <div className="mt-4 hidden overflow-hidden rounded-card border-[1.5px] border-clay md:block">
        <table className="w-full text-left text-sm">
          <thead className="bg-cream text-xs uppercase tracking-[0.14em] text-smoke">
            <tr>
              <th className="p-3" />
              <th className="p-3">Product</th>
              <th className="p-3">Type</th>
              <th className="p-3">Category</th>
              <th className="p-3">Price</th>
              <th className="p-3">Variants</th>
              <th className="p-3">Status</th>
              <th className="p-3">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-clay">
                <td className="p-3">
                  <input type="checkbox" checked={selected.includes(row.id)} onChange={(event) => toggle(row.id, event.target.checked)} aria-label={`Select ${row.name}`} />
                </td>
                <td className="p-3">
                  <Link href={`/admin/products/${row.id}`} className="font-semibold underline decoration-flame underline-offset-4">
                    {row.name}
                  </Link>
                  <p className="text-xs text-smoke">{row.slug}</p>
                </td>
                <td className="p-3">{row.productType.replaceAll("_", " ")}</td>
                <td className="p-3">{row.categoryName ?? "—"}</td>
                <td className="p-3">{formatPrice(row.pricePaise)}</td>
                <td className="p-3">{row.variantCount}</td>
                <td className="p-3">{row.status}</td>
                <td className="p-3">{new Date(row.updatedAt).toLocaleDateString("en-IN")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="mt-4 grid gap-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-card border-[1.5px] border-clay p-4">
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={selected.includes(row.id)} onChange={(event) => toggle(row.id, event.target.checked)} aria-label={`Select ${row.name}`} className="mt-1" />
              <span>
                <Link href={`/admin/products/${row.id}`} className="font-semibold underline decoration-flame underline-offset-4">
                  {row.name}
                </Link>
                <span className="mt-1 block text-xs text-smoke">
                  {row.productType.replaceAll("_", " ")} · {row.categoryName ?? "No category"} · {row.variantCount} variants
                </span>
                <span className="mt-1 block text-sm">{formatPrice(row.pricePaise)} · {row.status}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
