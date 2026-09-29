"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm } from "@/components/admin/action-form";
import { Button } from "@/components/ui/button";
import {
  archiveProductAction,
  deleteImageAction,
  discontinueProductAction,
  duplicateProductAction,
  makePrimaryImageAction,
  publishProductAction,
  retireVariantAction,
  saveSupplierMappingAction,
  saveVariantAction,
  uploadImageAction,
} from "@/server/actions/catalog-actions";

const fieldClass = "h-10 w-full rounded-full border-[1.5px] border-clay bg-white px-3 text-sm";

export function PublishBar({ id, blockers, status }: { id: string; blockers: string[]; status: string }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<{ ok: boolean; error?: string; message?: string; id?: string }>) {
    setError(null);
    const result = await work();
    if (!result.ok) {
      setError(result.error ?? "That action failed.");
      return;
    }
    setMessage(result.message ?? "Saved.");
    if (result.id && result.id !== id) router.push(`/admin/products/${result.id}`);
    else router.refresh();
  }

  return (
    <section className="rounded-card border-[1.5px] border-clay bg-cream p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-smoke">Status · {status}</p>
      {blockers.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
          {blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm">Publish checklist is clear.</p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" disabled={blockers.length > 0} onClick={() => run(() => publishProductAction(id))}>
          Publish
        </Button>
        <Button type="button" variant="outline" onClick={() => run(() => archiveProductAction(id))}>
          Archive
        </Button>
        <Button type="button" variant="outline" onClick={() => run(() => discontinueProductAction(id))}>
          Discontinue
        </Button>
        <Button type="button" variant="secondary" onClick={() => run(() => duplicateProductAction(id))}>
          Duplicate
        </Button>
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
      {message ? <p role="status" className="mt-3 text-sm">{message}</p> : null}
    </section>
  );
}

export function VariantForm({
  productId,
  colors,
  sizes,
}: {
  productId: string;
  colors: { name: string; hex: string }[];
  sizes: { code: string; label: string }[];
}) {
  return (
    <ActionForm action={saveVariantAction} className="grid gap-3 rounded-card border-[1.5px] border-clay p-4">
      <input type="hidden" name="productId" value={productId} />
      <h3 className="font-display text-lg font-bold uppercase">Add variant</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <input name="sku" required placeholder="SKU" className={fieldClass} />
        <input name="name" required placeholder="Label, e.g. Black / M" className={fieldClass} />
        <select name="size" className={fieldClass} defaultValue="">
          <option value="">No size</option>
          {sizes.map((size) => (
            <option key={size.code} value={size.code}>
              {size.label}
            </option>
          ))}
        </select>
        <select name="color" className={fieldClass} defaultValue="">
          <option value="">No color</option>
          {colors.map((color) => (
            <option key={color.name} value={color.name}>
              {color.name}
            </option>
          ))}
        </select>
        <input name="price" required inputMode="decimal" placeholder="Price INR" className={fieldClass} />
        <input name="compareAt" inputMode="decimal" placeholder="Compare-at INR" className={fieldClass} />
        <select name="availability" className={fieldClass} defaultValue="IN_STOCK">
          <option value="IN_STOCK">Available</option>
          <option value="LOW_STOCK">Low</option>
          <option value="OUT_OF_STOCK">Unavailable</option>
          <option value="PREORDER">Coming soon</option>
        </select>
        <input name="weightGrams" inputMode="numeric" placeholder="Weight grams" className={fieldClass} />
      </div>
      <Button type="submit" size="sm">
        Add variant
      </Button>
    </ActionForm>
  );
}

export function VariantRow({
  variantId,
  productId,
  label,
  values,
  colors,
  sizes,
}: {
  variantId: string;
  productId: string;
  label: string;
  values: {
    sku: string;
    name: string;
    size: string;
    color: string;
    price: string;
    compareAt: string;
    availability: string;
    weightGrams: string;
  };
  colors: { name: string }[];
  sizes: { code: string; label: string }[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-clay py-2 text-sm">
      <span>{label}</span>
      <Button
        type="button"
        size="sm"
        variant="outline-danger"
        onClick={async () => {
          const result = await retireVariantAction(variantId, productId);
          setMessage(result.ok ? result.message ?? "Updated." : result.error);
          if (result.ok) router.refresh();
        }}
      >
        Remove
      </Button>
      {message ? <p className="w-full text-xs text-smoke">{message}</p> : null}
      <details className="w-full">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.14em]">Edit</summary>
        <ActionForm action={saveVariantAction} className="mt-2 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="variantId" value={variantId} />
          <input name="sku" defaultValue={values.sku} className={fieldClass} />
          <input name="name" defaultValue={values.name} className={fieldClass} />
          <select name="size" defaultValue={values.size} className={fieldClass}>
            <option value="">No size</option>
            {sizes.map((size) => (
              <option key={size.code} value={size.code}>{size.label}</option>
            ))}
          </select>
          <select name="color" defaultValue={values.color} className={fieldClass}>
            <option value="">No color</option>
            {colors.map((color) => (
              <option key={color.name} value={color.name}>{color.name}</option>
            ))}
          </select>
          <input name="price" defaultValue={values.price} className={fieldClass} />
          <input name="compareAt" defaultValue={values.compareAt} className={fieldClass} />
          <select name="availability" defaultValue={values.availability} className={fieldClass}>
            <option value="IN_STOCK">Available</option>
            <option value="LOW_STOCK">Low</option>
            <option value="OUT_OF_STOCK">Unavailable</option>
            <option value="PREORDER">Coming soon</option>
          </select>
          <input name="weightGrams" defaultValue={values.weightGrams} className={fieldClass} />
          <Button type="submit" size="sm">Save variant</Button>
        </ActionForm>
      </details>
    </div>
  );
}

export function SupplierForm({ productId, variants }: { productId: string; variants: { id: string; sku: string }[] }) {
  return (
    <ActionForm action={saveSupplierMappingAction} className="grid gap-3 rounded-card border-[1.5px] border-clay p-4">
      <h3 className="font-display text-lg font-bold uppercase">Supplier identifiers</h3>
      <p className="text-xs text-smoke">Stored for a future supplier. Nothing is sent to a print provider.</p>
      <input type="hidden" name="productId" value={productId} />
      <input name="supplierProductId" required placeholder="Supplier product id" className={fieldClass} />
      {variants.map((variant) => (
        <div key={variant.id} className="grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="variantId" value={variant.id} />
          <input name={`supplierVariant:${variant.id}`} placeholder={`${variant.sku} variant id`} className={fieldClass} />
          <input name={`supplierSku:${variant.id}`} placeholder="Supplier SKU" className={fieldClass} />
        </div>
      ))}
      <Button type="submit" size="sm" variant="outline">Save identifiers</Button>
    </ActionForm>
  );
}

export function ImageUpload({ productId }: { productId: string }) {
  return (
    <ActionForm action={uploadImageAction} className="grid gap-3 rounded-card border-[1.5px] border-clay p-4">
      <input type="hidden" name="productId" value={productId} />
      <h3 className="font-display text-lg font-bold uppercase">Image</h3>
      <input name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="text-sm" />
      <input name="alt" placeholder="Alt text" className={fieldClass} />
      <select name="role" className={fieldClass} defaultValue="GALLERY">
        <option value="PRIMARY">Primary</option>
        <option value="GALLERY">Gallery</option>
        <option value="HOVER">Hover</option>
        <option value="THUMBNAIL">Thumbnail</option>
        <option value="MOBILE">Mobile</option>
        <option value="SOCIAL">Social</option>
      </select>
      <p className="text-xs text-smoke">JPG, PNG or WebP under 4 MB. The filename is not trusted.</p>
      <Button type="submit" size="sm">
        Upload
      </Button>
    </ActionForm>
  );
}

export function ImageRow({
  imageId,
  productId,
  alt,
  orderedIds,
}: {
  imageId: string;
  productId: string;
  alt: string;
  orderedIds: string[];
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="flex flex-wrap gap-1">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={async () => {
          const result = await deleteImageAction(imageId, productId);
          setMessage(result.ok ? result.message ?? "Removed." : result.error);
          if (result.ok) router.refresh();
        }}
      >
        Remove {alt || "image"}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={async () => {
          const next = [imageId, ...orderedIds.filter((id) => id !== imageId)];
          const result = await makePrimaryImageAction(productId, next);
          setMessage(result.ok ? result.message ?? "Reordered." : result.error);
          if (result.ok) router.refresh();
        }}
      >
        Make primary
      </Button>
      {message ? <span className="w-full text-xs text-smoke">{message}</span> : null}
    </span>
  );
}
