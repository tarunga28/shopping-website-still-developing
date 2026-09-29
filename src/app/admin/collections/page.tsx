import { AdminShell } from "@/components/layouts/admin-shell";
import { ActionForm } from "@/components/admin/action-form";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { saveCollectionAction, uploadOwnedImageAction } from "@/server/actions/catalog-actions";
import { listEditorOptions } from "@/services/catalog-admin.service";

export const dynamic = "force-dynamic";

export default async function AdminCollectionsPage() {
  await requireCatalogEditor();
  const options = await listEditorOptions().catch(() => null);
  if (!options) {
    return (
      <AdminShell>
        <ErrorState kind="api" title="Collections didn't load" description="Apply the catalog migration, then refresh." />
      </AdminShell>
    );
  }

  return (
    <AdminShell>
      <h1 className="font-display text-3xl font-extrabold uppercase">Collections</h1>
      <p className="mt-2 max-w-prose text-sm text-smoke">
        Optional start and end dates hide a collection outside its window. This is not a campaign engine.
      </p>
      <ActionForm action={saveCollectionAction} className="mt-6 grid max-w-xl gap-3 rounded-card border-[1.5px] border-clay p-4">
        <input name="name" required placeholder="Name" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="slug" placeholder="Slug" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <textarea name="description" placeholder="Description" className="min-h-24 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm" />
        <select name="status" defaultValue="DRAFT" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm">
          <option value="DRAFT">Draft</option>
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <input name="startsAt" type="datetime-local" aria-label="Starts" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="endsAt" type="datetime-local" aria-label="Ends" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="seoTitle" placeholder="SEO title" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="seoDescription" placeholder="SEO description" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="displayOrder" type="number" min={0} defaultValue={0} className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <input name="productIds" placeholder="Product ids, comma separated, in display order" className="h-10 rounded-full border-[1.5px] border-clay px-3 text-sm" />
        <Button type="submit" size="sm">Create collection</Button>
      </ActionForm>
      <ul className="mt-6 grid gap-3">
        {options.collections.map((collection) => (
          <li key={collection.id} className="rounded-card border-[1.5px] border-clay p-4 text-sm">
            <p className="font-semibold">{collection.name}</p>
            <p className="text-xs text-smoke">
              {collection.slug} · {collection.status}
              {collection.startsAt ? ` · from ${collection.startsAt.toISOString()}` : ""}
              {collection.endsAt ? ` · until ${collection.endsAt.toISOString()}` : ""}
            </p>
            <ActionForm action={saveCollectionAction} className="mt-3 grid gap-2">
              <input type="hidden" name="id" value={collection.id} />
              <input name="name" defaultValue={collection.name} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="slug" defaultValue={collection.slug} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <textarea name="description" defaultValue={collection.description ?? ""} className="min-h-16 rounded-card border-[1.5px] border-clay px-3 py-2 text-sm" />
              <select name="status" defaultValue={collection.status} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm">
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="ARCHIVED">Archived</option>
              </select>
              <input name="startsAt" type="datetime-local" defaultValue={collection.startsAt ? collection.startsAt.toISOString().slice(0, 16) : ""} aria-label="Starts" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="endsAt" type="datetime-local" defaultValue={collection.endsAt ? collection.endsAt.toISOString().slice(0, 16) : ""} aria-label="Ends" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="seoTitle" defaultValue={collection.seoTitle ?? ""} placeholder="SEO title" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="seoDescription" defaultValue={collection.seoDescription ?? ""} placeholder="SEO description" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="displayOrder" type="number" defaultValue={collection.displayOrder} className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <input name="productIds" placeholder="Replace products with these ids, in order. Blank keeps the current list." className="h-9 rounded-full border-[1.5px] border-clay px-3 text-sm" />
              <Button type="submit" size="sm" variant="outline">Save collection</Button>
            </ActionForm>
            <ActionForm action={uploadOwnedImageAction} className="mt-2 flex flex-wrap items-center gap-2">
              <input type="hidden" name="collectionId" value={collection.id} />
              <input name="file" type="file" accept="image/jpeg,image/png,image/webp" required aria-label={`Image for ${collection.name}`} className="text-xs" />
              <input name="alt" placeholder="Alt text" className="h-9 rounded-full border-[1.5px] border-clay px-3 text-xs" />
              <Button type="submit" size="sm" variant="secondary">Upload image</Button>
            </ActionForm>
          </li>
        ))}
      </ul>
    </AdminShell>
  );
}
