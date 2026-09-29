import { AdminShell } from "@/components/layouts/admin-shell";
import { ActionForm } from "@/components/admin/action-form";
import { CategoryArchive } from "@/components/admin/category-archive";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { saveCategoryAction, uploadOwnedImageAction } from "@/server/actions/catalog-actions";
import { listEditorOptions } from "@/services/catalog-admin.service";

export const dynamic = "force-dynamic";

export default async function AdminCategoriesPage() {
  await requireCatalogEditor();
  const options = await listEditorOptions().catch(() => null);
  if (!options) {
    return (
      <AdminShell>
        <ErrorState kind="api" title="Categories didn't load" description="Apply the catalog migration, then refresh." />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Categories</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">Archiving keeps the row. Active products must be moved first.</p>
      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <ActionForm action={saveCategoryAction} className="grid gap-3 rounded-card border-[1.5px] border-clay p-4">
          <h2 className="font-display text-lg font-bold uppercase">New category</h2>
          <input name="name" required placeholder="Name" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
          <input name="slug" placeholder="Slug" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
          <textarea name="description" placeholder="Description" className="min-h-24 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm" />
          <select name="parentId" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" defaultValue="">
            <option value="">No parent</option>
            {options.categories.map((category) => (
              <option key={category.id} value={category.id}>{category.name}</option>
            ))}
          </select>
          <input name="seoTitle" placeholder="SEO title" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
          <input name="seoDescription" placeholder="SEO description" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
          <input name="displayOrder" type="number" min={0} defaultValue={0} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
          <Button type="submit" size="sm">Create</Button>
        </ActionForm>
        <ul className="grid gap-3">
          {options.categories.map((category) => (
            <li key={category.id} className="rounded-card border-[1.5px] border-clay p-4">
              <p className="font-semibold">{category.name}</p>
              <p className="text-xs text-smoke">{category.slug} · {category.isActive ? "Active" : "Archived"} · order {category.displayOrder}</p>
              <ActionForm action={saveCategoryAction} className="mt-3 grid gap-2">
                <input type="hidden" name="id" value={category.id} />
                <input name="name" defaultValue={category.name} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="slug" defaultValue={category.slug} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <textarea name="description" defaultValue={category.description ?? ""} className="min-h-16 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm" />
                <input name="seoTitle" defaultValue={category.seoTitle ?? ""} placeholder="SEO title" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="seoDescription" defaultValue={category.seoDescription ?? ""} placeholder="SEO description" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <input name="displayOrder" type="number" defaultValue={category.displayOrder} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
                <select name="parentId" defaultValue={category.parentId ?? ""} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm">
                  <option value="">No parent</option>
                  {options.categories.filter((item) => item.id !== category.id).map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <Button type="submit" size="sm" variant="outline">Save category</Button>
              </ActionForm>
              <ActionForm action={uploadOwnedImageAction} className="mt-2 flex flex-wrap items-center gap-2">
                <input type="hidden" name="categoryId" value={category.id} />
                <input name="file" type="file" accept="image/jpeg,image/png,image/webp" required aria-label={`Image for ${category.name}`} className="text-xs" />
                <input name="alt" placeholder="Alt text" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-xs" />
                <Button type="submit" size="sm" variant="secondary">Upload image</Button>
              </ActionForm>
              {category.isActive ? (
                <CategoryArchive id={category.id} others={options.categories.filter((item) => item.id !== category.id && item.isActive).map((item) => ({ id: item.id, name: item.name }))} />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </AdminShell>
  );
}
