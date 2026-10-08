import Link from "next/link";

import { AdminShell } from "@/components/layouts/admin-shell";
import { ActionForm } from "@/components/admin/action-form";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { adjustInventoryAction } from "@/server/actions/catalog-actions";
import { listInventoryForAdmin, getLowStockReport } from "@/services/catalog/inventory.service";
import { INVENTORY_OPERATIONS } from "@/validations/catalog";

export const dynamic = "force-dynamic";

const SORTS = [
  { value: "available-asc", label: "Least available" },
  { value: "available-desc", label: "Most available" },
  { value: "stock-asc", label: "Lowest on hand" },
  { value: "sku", label: "SKU" },
] as const;

type SortValue = (typeof SORTS)[number]["value"];

const PAGE_SIZE = 50;

function isSort(value: string | null): value is SortValue {
  return SORTS.some((sort) => sort.value === value);
}

function qs(current: URLSearchParams, patch: Record<string, string | null>) {
  const next = new URLSearchParams(current.toString());
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  // Any change to the filter or sort invalidates the current page position.
  if (!("page" in patch)) next.delete("page");
  return next.toString();
}

/**
 * Inventory administration.
 *
 * Filtering, sorting and pagination are all URL-driven and executed in SQL, so
 * the page costs the same against 100k products as against 100 — the server
 * never loads a catalog page it is not about to render.
 *
 * Every adjustment posts through the ledger, so the screen cannot create stock
 * the ledger cannot explain.
 */
export default async function AdminInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCatalogEditor();

  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const search = params.get("search") ?? "";
  const sortRaw = params.get("sort");
  const sort: SortValue = isSort(sortRaw) ? sortRaw : "available-asc";
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const onlyLowStock = params.get("stock") === "low";
  const onlyOutOfStock = params.get("stock") === "out";
  const status = params.get("status");

  const [inventory, lowStock] = await Promise.all([
    listInventoryForAdmin({
      search: search || null,
      sort,
      onlyLowStock,
      onlyOutOfStock,
      productStatus: status,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }).catch(() => null),
    getLowStockReport({ limit: 1 }).catch(() => null),
  ]);

  if (!inventory) {
    return (
      <AdminShell>
        <ErrorState kind="api" title="Inventory didn't load" description="Apply the catalog migration, then refresh." />
      </AdminShell>
    );
  }

  const rows = inventory.rows;
  const totalPages = Math.max(1, Math.ceil(inventory.total / PAGE_SIZE));
  const from = inventory.total === 0 ? 0 : inventory.offset + 1;
  const to = Math.min(inventory.total, inventory.offset + rows.length);

  const inputClass = "h-9 rounded-full border-[1.5px] border-clay px-3 text-sm";

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Inventory</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        Stock moves through a ledger. Every adjustment below records the previous balance, the movement and the new
        balance, so a number can always be explained.
        {lowStock && lowStock.total > 0 ? ` ${lowStock.total} variant${lowStock.total === 1 ? "" : "s"} need attention.` : ""}
      </p>

      <form method="get" className="mt-6 flex flex-wrap items-center gap-2">
        <input name="search" defaultValue={search} placeholder="Search SKU or product" className={`${inputClass} w-64`} />
        <select name="stock" defaultValue={params.get("stock") ?? ""} className={inputClass} aria-label="Stock filter">
          <option value="">All stock levels</option>
          <option value="low">Low stock only</option>
          <option value="out">Out of stock only</option>
        </select>
        <select name="sort" defaultValue={sort} className={inputClass} aria-label="Sort by">
          {SORTS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select name="status" defaultValue={status ?? ""} className={inputClass} aria-label="Product status">
          <option value="">Any product status</option>
          <option value="ACTIVE">Active products only</option>
        </select>
        <Button type="submit" size="sm">Apply</Button>
      </form>

      <div className="mt-4 overflow-x-auto rounded-card border-[1.5px] border-clay">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-sand text-left font-mono text-[10px] uppercase tracking-[0.14em] text-smoke">
            <tr>
              <th className="px-4 py-3">SKU</th>
              <th className="px-4 py-3">Variant</th>
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3 text-right">On hand</th>
              <th className="px-4 py-3 text-right">Reserved</th>
              <th className="px-4 py-3 text-right">Available</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-clay/60">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-smoke">
                  No variants match those filters.
                </td>
              </tr>
            ) : null}
            {rows.map((row) => (
              <tr key={row.variantId} className="align-top">
                <td className="px-4 py-3 font-mono text-xs">{row.sku}</td>
                <td className="px-4 py-3">{row.name}</td>
                <td className="px-4 py-3">
                  <Link href={`/admin/products/${row.productId}`} className="hover:underline">
                    {row.productName}
                  </Link>
                  <p className="font-mono text-[10px] uppercase text-smoke">{row.productStatus}</p>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{row.stockQuantity}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.reservedQuantity}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <span className={row.availableQuantity <= 0 ? "font-semibold text-danger" : ""}>
                    {row.availableQuantity}
                  </span>
                  {row.isLowStock && row.availableQuantity > 0 ? (
                    <span className="ml-2 rounded-full bg-clay/40 px-2 py-0.5 font-mono text-[10px] uppercase">
                      Low · {row.lowStockThreshold}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3">
                  <ActionForm action={adjustInventoryAction} className="flex flex-wrap items-center gap-1.5">
                    <input type="hidden" name="productId" value={row.productId} />
                    <input type="hidden" name="variantId" value={row.variantId} />
                    <select name="operation" defaultValue="MANUAL_ADJUSTMENT" className="h-8 rounded-full border-[1.5px] border-clay px-2 text-xs" aria-label={`Operation for ${row.sku}`}>
                      {INVENTORY_OPERATIONS.map((operation) => (
                        <option key={operation} value={operation}>{operation}</option>
                      ))}
                    </select>
                    <input
                      name="quantity"
                      type="number"
                      required
                      defaultValue={1}
                      aria-label={`Quantity for ${row.sku}`}
                      className="h-8 w-20 rounded-full border-[1.5px] border-clay px-2 text-xs tabular-nums"
                    />
                    <input name="reason" placeholder="Reason" className="h-8 w-28 rounded-full border-[1.5px] border-clay px-2 text-xs" />
                    <input type="hidden" name="referenceType" value="MANUAL" />
                    <Button type="submit" size="sm" variant="secondary">Apply</Button>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="font-mono text-xs text-smoke">
          Showing {from}–{to} of {inventory.total}
        </p>
        <div className="flex items-center gap-2">
          <Link
            href={{ pathname: "/admin/inventory", search: qs(params, { page: String(page - 1) }) }}
            aria-disabled={page <= 1}
            className={`rounded-full border-[1.5px] border-clay px-3 py-1.5 text-xs ${page <= 1 ? "pointer-events-none opacity-40" : ""}`}
          >
            Previous
          </Link>
          <span className="font-mono text-xs text-smoke">
            Page {page} of {totalPages}
          </span>
          <Link
            href={{ pathname: "/admin/inventory", search: qs(params, { page: String(page + 1) }) }}
            aria-disabled={page >= totalPages}
            className={`rounded-full border-[1.5px] border-clay px-3 py-1.5 text-xs ${page >= totalPages ? "pointer-events-none opacity-40" : ""}`}
          >
            Next
          </Link>
        </div>
      </div>
    </AdminShell>
  );
}
