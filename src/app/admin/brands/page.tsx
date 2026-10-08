import { AdminShell } from "@/components/layouts/admin-shell";
import { ActionForm } from "@/components/admin/action-form";
import { BrandArchive } from "@/components/admin/brand-archive";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { saveBrandAction } from "@/server/actions/catalog-actions";
import { listBrands } from "@/services/catalog/brand.service";

export const dynamic = "force-dynamic";

const field = "h-10 rounded-full border-[1.5px] border-clay px-3 text-sm";

/**
 * Brands administration.
 *
 * Inactive brands are listed alongside active ones: the whole point of the
 * screen is to find and reactivate a disabled brand, so hiding them here would
 * defeat it. The public API hides them instead — this screen is editor-only.
 */
export default async function AdminBrandsPage() {
  await requireCatalogEditor();

  const brands = await listBrands({ includeInactive: true, limit: 200 }).catch(() => null);
  if (!brands) {
    return (
      <AdminShell>
        <ErrorState kind="api" title="Brands didn't load" description="Apply the catalog migration, then refresh." />
      </AdminShell>
    );
  }

  const active = brands.filter((brand) => brand.isActive);
  const inactive = brands.filter((brand) => !brand.isActive);

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Brands</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        {active.length} active · {inactive.length} inactive. Deactivating keeps the brand on existing products.
      </p>

      <div className="mt-6 grid gap-8 lg:grid-cols-[22rem_1fr]">
        <ActionForm action={saveBrandAction} className="h-fit rounded-card border-[1.5px] border-clay p-4">
          <h2 className="font-display text-lg font-bold uppercase">New brand</h2>
          <div className="mt-3 grid gap-3">
            <input name="name" required placeholder="Name" className={field} />
            <input name="slug" placeholder="Slug (derived from the name when empty)" className={field} />
            <textarea
              name="description"
              placeholder="Description"
              className="min-h-24 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm"
            />
            <input name="logoUrl" type="url" placeholder="Logo URL" className={field} />
            <input name="bannerUrl" type="url" placeholder="Banner URL" className={field} />
            <input name="website" type="url" placeholder="Website" className={field} />
            <input name="seoTitle" placeholder="SEO title" className={field} />
            <input name="seoDescription" placeholder="SEO description" className={field} />
            <input name="displayOrder" type="number" min={0} defaultValue={0} className={field} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isActive" defaultChecked className="size-4" />
              Active
            </label>
            <Button type="submit" size="sm">Create brand</Button>
          </div>
        </ActionForm>

        <div className="grid gap-4">
          {brands.length === 0 ? (
            <p className="rounded-card border-[1.5px] border-clay p-6 text-sm text-smoke">
              No brands yet. Create the first one on the left.
            </p>
          ) : null}

          {[...active, ...inactive].map((brand) => (
            <article key={brand.id} className="rounded-card border-[1.5px] border-clay p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-semibold">
                  {brand.name}
                  {brand.isActive ? null : (
                    <span className="ml-2 rounded-full bg-clay/40 px-2 py-0.5 font-mono text-[10px] uppercase">
                      Inactive
                    </span>
                  )}
                </h3>
                <p className="font-mono text-xs text-smoke">
                  {brand.productCount} product{brand.productCount === 1 ? "" : "s"} · order {brand.displayOrder}
                </p>
              </div>
              <p className="mt-1 font-mono text-xs text-smoke">/{brand.slug}</p>
              {brand.description ? <p className="mt-2 text-sm">{brand.description}</p> : null}

              <ActionForm action={saveBrandAction} className="mt-3 grid gap-2">
                <input type="hidden" name="id" value={brand.id} />
                <input name="name" defaultValue={brand.name} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="slug" defaultValue={brand.slug} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <textarea
                  name="description"
                  defaultValue={brand.description ?? ""}
                  placeholder="Description"
                  className="min-h-16 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm"
                />
                <input name="logoUrl" type="url" defaultValue={brand.logoUrl ?? ""} placeholder="Logo URL" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="bannerUrl" type="url" defaultValue={brand.bannerUrl ?? ""} placeholder="Banner URL" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="website" type="url" defaultValue={brand.website ?? ""} placeholder="Website" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="seoTitle" defaultValue={brand.seoTitle ?? ""} placeholder="SEO title" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="seoDescription" defaultValue={brand.seoDescription ?? ""} placeholder="SEO description" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="displayOrder" type="number" defaultValue={brand.displayOrder} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="isActive" defaultChecked={brand.isActive} className="size-4" />
                  Active
                </label>
                <Button type="submit" size="sm" variant="secondary">Save changes</Button>
              </ActionForm>

              <BrandArchive id={brand.id} productCount={brand.productCount} />
            </article>
          ))}
        </div>
      </div>
    </AdminShell>
  );
}
