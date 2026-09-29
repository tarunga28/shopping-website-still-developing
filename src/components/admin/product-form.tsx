"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ActionForm } from "@/components/admin/action-form";
import { Button } from "@/components/ui/button";
import { DESIGN_PLACEMENTS, PRODUCT_TYPES } from "@/lib/catalog-rules";
import { createProductAction, updateProductAction, type CatalogActionResult } from "@/server/actions/catalog-actions";

export interface EditorOptions {
  categories: { id: string; name: string; isActive: boolean }[];
  collections: { id: string; name: string }[];
  designs: { id: string; name: string }[];
  sizes: { code: string; label: string; productType: string }[];
}

export interface ProductFormValues {
  id?: string;
  name: string;
  slug: string;
  shortDescription: string;
  description: string;
  productType: string;
  categoryIds: string[];
  primaryCategoryId: string;
  collectionIds: string[];
  tags: string;
  basePrice: string;
  compareAt: string;
  seoTitle: string;
  seoDescription: string;
  adminNotes: string;
  estimatedShipping: string;
  estimatedPaymentFee: string;
  supplierMappingRequired: boolean;
  designId: string;
  placement: string;
}

const fieldClass = "h-11 w-full rounded-full border-[1.5px] border-clay bg-white px-4 text-sm";
const areaClass = "min-h-28 w-full rounded-card border-[1.5px] border-clay bg-white px-4 py-3 text-sm";

export function ProductForm({ values, options }: { values: ProductFormValues; options: EditorOptions }) {
  const action = values.id ? updateProductAction : createProductAction;
  return (
    <BoundForm action={action} productId={values.id}>
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke md:col-span-2">
          Name
          <input name="name" required defaultValue={values.name} className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Slug
          <input name="slug" defaultValue={values.slug} placeholder="Leave blank to generate" className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Type
          <TypeSelect initial={values.productType} sizes={options.sizes} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke md:col-span-2">
          Short description
          <input name="shortDescription" defaultValue={values.shortDescription} maxLength={280} className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke md:col-span-2">
          Full description
          <textarea name="description" defaultValue={values.description} className={areaClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Selling price (INR)
          <input name="basePrice" required inputMode="decimal" defaultValue={values.basePrice} className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Compare-at (INR)
          <input name="compareAt" inputMode="decimal" defaultValue={values.compareAt} className={fieldClass} />
        </label>
        <fieldset className="grid gap-2 md:col-span-2">
          <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-smoke">Categories</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.categories.filter((category) => category.isActive || values.categoryIds.includes(category.id)).map((category) => (
              <label key={category.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="categoryIds" value={category.id} defaultChecked={values.categoryIds.includes(category.id)} />
                {category.name}
              </label>
            ))}
          </div>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
            Primary category
            <select name="primaryCategoryId" defaultValue={values.primaryCategoryId} className={fieldClass}>
              <option value="">First selected</option>
              {options.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
        <fieldset className="grid gap-2 md:col-span-2">
          <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-smoke">Collections</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {options.collections.map((collection) => (
              <label key={collection.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="collectionIds" value={collection.id} defaultChecked={values.collectionIds.includes(collection.id)} />
                {collection.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke md:col-span-2">
          Tags
          <input name="tags" defaultValue={values.tags} placeholder="minimal, gaming" className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Design
          <select name="designId" defaultValue={values.designId} className={fieldClass}>
            <option value="">None</option>
            {options.designs.map((design) => (
              <option key={design.id} value={design.id}>
                {design.name}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          Placement
          <select name="placement" defaultValue={values.placement} className={fieldClass}>
            {DESIGN_PLACEMENTS.map((placement) => (
              <option key={placement} value={placement}>
                {placement.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          SEO title
          <input name="seoTitle" defaultValue={values.seoTitle} maxLength={70} className={fieldClass} />
        </label>
        <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
          SEO description
          <input name="seoDescription" defaultValue={values.seoDescription} maxLength={160} className={fieldClass} />
        </label>
      </div>
      <details className="mt-4 rounded-card border-[1.5px] border-clay p-4">
        <summary className="cursor-pointer text-sm font-semibold">Internal costs and notes</summary>
        <p className="mt-2 text-xs text-smoke">Not shown on the storefront. This is an estimate, not profit.</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
            Estimated shipping (INR)
            <input name="estimatedShipping" defaultValue={values.estimatedShipping} className={fieldClass} />
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke">
            Estimated payment fee (INR)
            <input name="estimatedPaymentFee" defaultValue={values.estimatedPaymentFee} className={fieldClass} />
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" name="supplierMappingRequired" defaultChecked={values.supplierMappingRequired} />
            Require supplier mapping before publish
          </label>
          <label className="grid gap-1 text-xs font-semibold uppercase tracking-[0.14em] text-smoke md:col-span-2">
            Admin notes
            <textarea name="adminNotes" defaultValue={values.adminNotes} className={areaClass} />
          </label>
        </div>
      </details>
      <Button type="submit" className="mt-4">
        {values.id ? "Save product" : "Create draft"}
      </Button>
    </BoundForm>
  );
}

function BoundForm({
  action,
  productId,
  children,
}: {
  action: (prev: CatalogActionResult | null, form: FormData) => Promise<CatalogActionResult>;
  productId?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <CreateRedirect action={action} productId={productId} onCreated={(id) => router.push(`/admin/products/${id}`)}>
      {children}
    </CreateRedirect>
  );
}

function CreateRedirect({
  action,
  productId,
  onCreated,
  children,
}: {
  action: (prev: CatalogActionResult | null, form: FormData) => Promise<CatalogActionResult>;
  productId?: string;
  onCreated: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <RedirectingForm action={action} productId={productId} onCreated={onCreated}>
      {children}
    </RedirectingForm>
  );
}

function RedirectingForm({
  action,
  productId,
  onCreated,
  children,
}: {
  action: (prev: CatalogActionResult | null, form: FormData) => Promise<CatalogActionResult>;
  productId?: string;
  onCreated: (id: string) => void;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<CatalogActionResult | null>(null);
  useEffect(() => {
    if (state?.ok && state.id && state.id !== productId) onCreated(state.id);
  }, [state, productId, onCreated]);
  return (
    <ActionForm
      action={async (prev, form) => {
        const next = await action(prev, form);
        setState(next);
        return next;
      }}
      className="grid gap-4"
    >
      {children}
    </ActionForm>
  );
}

function TypeSelect({ initial, sizes }: { initial: string; sizes: EditorOptions["sizes"] }) {
  const [type, setType] = useState(initial || "T_SHIRT");
  const applicable = useMemo(() => sizes.filter((size) => size.productType === type), [sizes, type]);
  return (
    <>
      <select name="productType" value={type} onChange={(event) => setType(event.target.value)} className={fieldClass}>
        {PRODUCT_TYPES.map((item) => (
          <option key={item} value={item}>
            {item.replaceAll("_", " ")}
          </option>
        ))}
      </select>
      <span className="text-[11px] font-normal normal-case tracking-normal text-smoke">
        {applicable.length ? `Sizes for this type: ${[...new Set(applicable.map((size) => size.label))].join(", ")}` : "No size is required for this type."}
      </span>
    </>
  );
}
