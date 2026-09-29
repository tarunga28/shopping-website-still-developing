import { AdminShell } from "@/components/layouts/admin-shell";
import { ProductForm } from "@/components/admin/product-form";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { listEditorOptions } from "@/services/catalog-admin.service";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  await requireCatalogEditor();
  const options = await listEditorOptions().catch(() => null);
  if (!options) {
    return (
      <AdminShell>
        <ErrorState kind="api" title="Catalog tables are not ready" description="Apply drizzle/0003_catalog_management.sql, then refresh." />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">New product</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        This saves a draft. It cannot be purchased until the publish checklist passes.
      </p>
      <div className="mt-6 max-w-3xl">
        <ProductForm
          options={{
            categories: options.categories.map((category) => ({ id: category.id, name: category.name, isActive: category.isActive })),
            collections: options.collections.map((collection) => ({ id: collection.id, name: collection.name })),
            designs: options.designs,
            sizes: options.sizes,
          }}
          values={{
            name: "",
            slug: "",
            shortDescription: "",
            description: "",
            productType: "T_SHIRT",
            categoryIds: [],
            primaryCategoryId: "",
            collectionIds: [],
            tags: "",
            basePrice: "",
            compareAt: "",
            seoTitle: "",
            seoDescription: "",
            adminNotes: "",
            estimatedShipping: "",
            estimatedPaymentFee: "",
            supplierMappingRequired: false,
            designId: "",
            placement: "FRONT",
          }}
        />
      </div>
    </AdminShell>
  );
}
