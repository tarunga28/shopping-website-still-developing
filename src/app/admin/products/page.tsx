import Link from "next/link";
import { AdminShell } from "@/components/layouts/admin-shell";
import { AdminFilterDrawer } from "@/components/admin/filter-drawer";
import { ProductAdminList } from "@/components/admin/product-list";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PRODUCT_STATUSES, PRODUCT_TYPES } from "@/lib/catalog-rules";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { listEditorOptions } from "@/services/catalog-admin.service";
import { catalogQueryFromSearch, listCatalog } from "@/services/catalog-query.service";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage({
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

  let page;
  let options;
  try {
    [page, options] = await Promise.all([
      listCatalog(catalogQueryFromSearch(params, "admin")),
      listEditorOptions(),
    ]);
  } catch {
    return (
      <AdminShell>
        <ErrorState
          kind="api"
          title="Catalog tables are not ready"
          description="Apply drizzle/0003_catalog_management.sql, then refresh."
        />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-extrabold uppercase">Products</h1>
          <p className="mt-1 text-sm text-smoke">{page.total} in this filter. Costs stay in the editor.</p>
        </div>
        <Button asChild>
          <Link href="/admin/products/new">New product</Link>
        </Button>
      </header>

      <AdminFilterDrawer>
      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" action="/admin/products">
        <input name="q" defaultValue={params.get("q") ?? ""} placeholder="Name, slug, SKU, tag" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <select name="status" defaultValue={params.get("status") ?? ""} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm">
          <option value="">Any status</option>
          {PRODUCT_STATUSES.map((status) => (
            <option key={status} value={status}>{status}</option>
          ))}
        </select>
        <select name="type" defaultValue={params.get("type") ?? ""} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm">
          <option value="">Any type</option>
          {PRODUCT_TYPES.map((type) => (
            <option key={type} value={type}>{type.replaceAll("_", " ")}</option>
          ))}
        </select>
        <select name="pageSize" defaultValue={params.get("pageSize") ?? "20"} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm">
          <option value="20">20</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
        <Button type="submit" size="sm" variant="outline">Filter</Button>
      </form>
      </AdminFilterDrawer>

      {page.items.length === 0 ? (
        <EmptyState title="No products in this view" description="Create a draft, or clear the filter." action={{ label: "New product", href: "/admin/products/new" }} />
      ) : (
        <ProductAdminList
          rows={page.items}
          categories={options.categories.filter((category) => category.isActive).map((category) => ({ id: category.id, name: category.name }))}
          collections={options.collections.map((collection) => ({ id: collection.id, name: collection.name }))}
        />
      )}
    </AdminShell>
  );
}
