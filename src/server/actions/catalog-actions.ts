"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { linesToList, textToSpecs } from "@/lib/catalog/product-details";
import { AppError, ValidationError } from "@/lib/errors";
import { requireCatalogEditor } from "@/server/auth/catalog-access";
import { authRequestContext } from "@/server/auth/session";
import {
  addVariant,
  archiveCategory,
  archiveProduct,
  bulkCatalog,
  createCategory,
  createColor,
  createProduct,
  deleteProductImage,
  discontinueProduct,
  duplicateProduct,
  publishProduct,
  reorderProductImages,
  retireVariant,
  saveSupplierMapping,
  saveCollection,
  updateCategory,
  updateProduct,
  updateVariant,
  uploadOwnedImage,
  uploadProductImage,
} from "@/services/catalog-admin.service";
import {
  bulkSchema,
  categoryWriteSchema,
  collectionWriteSchema,
  productWriteSchema,
  variantWriteSchema,
} from "@/validations/catalog";

export type CatalogActionResult = { ok: true; message?: string; id?: string } | { ok: false; error: string };

function fail(error: unknown): CatalogActionResult {
  if (error instanceof AppError) return { ok: false, error: error.message };
  return { ok: false, error: "Something went wrong. Nothing was saved." };
}

async function actor() {
  const user = await requireCatalogEditor();
  const context = await authRequestContext(await headers());
  return { id: user.id, role: user.role, ...context };
}

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function ids(form: FormData, key: string): string[] {
  return form.getAll(key).filter((value): value is string => typeof value === "string" && value.length > 0);
}

/** Spec lines must read "Label: Value". Tell the editor instead of silently dropping a line. */
function detailsProblem(form: FormData): string | null {
  const bad = linesToList(text(form, "detailSpecs")).find((line) => line.indexOf(":") <= 0 || line.endsWith(":"));
  return bad ? `Each specification needs the form "Label: Value" (check "${bad.slice(0, 40)}").` : null;
}

function productInput(form: FormData) {
  return productWriteSchema.safeParse({
    name: text(form, "name"),
    slug: text(form, "slug"),
    shortDescription: text(form, "shortDescription"),
    description: text(form, "description"),
    productType: text(form, "productType"),
    categoryIds: ids(form, "categoryIds"),
    primaryCategoryId: text(form, "primaryCategoryId"),
    collectionIds: ids(form, "collectionIds"),
    tags: text(form, "tags")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    basePrice: text(form, "basePrice"),
    compareAt: text(form, "compareAt"),
    currency: "INR",
    seoTitle: text(form, "seoTitle"),
    seoDescription: text(form, "seoDescription"),
    adminNotes: text(form, "adminNotes"),
    estimatedShipping: text(form, "estimatedShipping"),
    estimatedPaymentFee: text(form, "estimatedPaymentFee"),
    supplierMappingRequired: form.get("supplierMappingRequired") === "on",
    designId: text(form, "designId"),
    placement: text(form, "placement") || "FRONT",
    details: {
      features: linesToList(text(form, "detailFeatures")),
      materials: text(form, "detailMaterials"),
      fit: text(form, "detailFit"),
      care: linesToList(text(form, "detailCare")),
      printDetails: text(form, "detailPrintDetails"),
      specs: textToSpecs(text(form, "detailSpecs")),
    },
  });
}

function refresh(paths: string[]) {
  for (const path of paths) revalidatePath(path);
}

export async function createProductAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const problem = detailsProblem(form);
  if (problem) return { ok: false, error: problem };
  const parsed = productInput(form);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const created = await createProduct(await actor(), parsed.data);
    refresh(["/admin/products", "/shop"]);
    return { ok: true, id: created.id, message: "Draft saved. Add an image and a variant before publishing." };
  } catch (error) {
    return fail(error);
  }
}

export async function updateProductAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const id = text(form, "id");
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: "Missing product." };
  const problem = detailsProblem(form);
  if (problem) return { ok: false, error: problem };
  const parsed = productInput(form);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    await updateProduct(await actor(), id, parsed.data);
    refresh([`/admin/products/${id}`, "/admin/products", "/shop"]);
    return { ok: true, id, message: "Product saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function publishProductAction(id: string): Promise<CatalogActionResult> {
  try {
    await publishProduct(await actor(), id);
    refresh([`/admin/products/${id}`, "/shop", `/product`]);
    return { ok: true, message: "Published. It can appear on the storefront." };
  } catch (error) {
    return fail(error);
  }
}

export async function archiveProductAction(id: string): Promise<CatalogActionResult> {
  try {
    await archiveProduct(await actor(), id);
    refresh([`/admin/products/${id}`, "/shop"]);
    return { ok: true, message: "Archived. It is hidden from browsing." };
  } catch (error) {
    return fail(error);
  }
}

export async function discontinueProductAction(id: string): Promise<CatalogActionResult> {
  try {
    await discontinueProduct(await actor(), id);
    refresh([`/admin/products/${id}`, "/shop"]);
    return { ok: true, message: "Discontinued. Existing orders stay intact. New purchases are blocked." };
  } catch (error) {
    return fail(error);
  }
}

export async function duplicateProductAction(id: string): Promise<CatalogActionResult> {
  try {
    const copy = await duplicateProduct(await actor(), id);
    refresh(["/admin/products"]);
    return { ok: true, id: copy.id, message: "Copy created as a draft with new SKUs." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveVariantAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const productId = text(form, "productId");
  const variantId = text(form, "variantId");
  const weight = text(form, "weightGrams");
  const parsed = variantWriteSchema.safeParse({
    sku: text(form, "sku").toUpperCase(),
    name: text(form, "name"),
    size: text(form, "size"),
    color: text(form, "color"),
    price: text(form, "price"),
    compareAt: text(form, "compareAt"),
    availability: text(form, "availability") || "IN_STOCK",
    weightGrams: weight ? Number(weight) : null,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the variant." };
  try {
    const user = await actor();
    if (variantId) await updateVariant(user, variantId, parsed.data);
    else await addVariant(user, productId, parsed.data);
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: variantId ? "Variant updated." : "Variant added." };
  } catch (error) {
    return fail(error);
  }
}

export async function retireVariantAction(variantId: string, productId: string): Promise<CatalogActionResult> {
  try {
    const result = await retireVariant(await actor(), variantId);
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: result.deleted ? "Variant removed." : "Variant marked unavailable because an order references it." };
  } catch (error) {
    return fail(error);
  }
}

export async function uploadImageAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const productId = text(form, "productId");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file." };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await uploadProductImage(await actor(), productId, {
      bytes,
      declaredMime: file.type || "application/octet-stream",
      alt: text(form, "alt"),
      role: text(form, "role") || "GALLERY",
    });
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: "Image saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function makePrimaryImageAction(productId: string, orderedIds: string[]): Promise<CatalogActionResult> {
  try {
    await reorderProductImages(await actor(), productId, orderedIds);
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: "Image order saved. The first image is primary." };
  } catch (error) {
    return fail(error);
  }
}

export async function uploadOwnedImageAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const file = form.get("file");
  const categoryId = text(form, "categoryId");
  const collectionId = text(form, "collectionId");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose an image file." };
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    await uploadOwnedImage(await actor(), { categoryId: categoryId || undefined, collectionId: collectionId || undefined }, {
      bytes,
      declaredMime: file.type || "application/octet-stream",
      alt: text(form, "alt"),
    });
    refresh(["/admin/categories", "/admin/collections"]);
    return { ok: true, message: "Image saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteImageAction(imageId: string, productId: string): Promise<CatalogActionResult> {
  try {
    await deleteProductImage(await actor(), imageId);
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: "Image removed." };
  } catch (error) {
    return fail(error);
  }
}

export async function bulkCatalogAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const parsed = bulkSchema.safeParse({
    action: text(form, "action"),
    productIds: ids(form, "productIds"),
    confirmation: text(form, "confirmation"),
    categoryId: text(form, "categoryId") || undefined,
    collectionId: text(form, "collectionId") || undefined,
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the bulk action." };
  try {
    const result = await bulkCatalog(await actor(), parsed.data);
    refresh(["/admin/products", "/shop"]);
    if (result.failures.length) {
      return { ok: false, error: `${result.updated} updated. ${result.failures.length} skipped: ${result.failures[0]?.reason}` };
    }
    return { ok: true, message: `${result.updated} products updated.` };
  } catch (error) {
    return fail(error);
  }
}

export async function saveCategoryAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const id = text(form, "id");
  const parsed = categoryWriteSchema.safeParse({
    name: text(form, "name"),
    slug: text(form, "slug"),
    description: text(form, "description"),
    parentId: text(form, "parentId"),
    seoTitle: text(form, "seoTitle"),
    seoDescription: text(form, "seoDescription"),
    displayOrder: Number(text(form, "displayOrder") || "0"),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the category." };
  try {
    const user = await actor();
    if (id) await updateCategory(user, id, parsed.data);
    else await createCategory(user, parsed.data);
    refresh(["/admin/categories"]);
    return { ok: true, message: id ? "Category saved." : "Category created." };
  } catch (error) {
    return fail(error);
  }
}

export async function archiveCategoryAction(id: string, reassignToId: string): Promise<CatalogActionResult> {
  try {
    await archiveCategory(await actor(), id, reassignToId || null);
    refresh(["/admin/categories"]);
    return { ok: true, message: "Category archived." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveCollectionAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const id = text(form, "id");
  const parsed = collectionWriteSchema.safeParse({
    name: text(form, "name"),
    slug: text(form, "slug"),
    description: text(form, "description"),
    status: text(form, "status") || "DRAFT",
    seoTitle: text(form, "seoTitle"),
    seoDescription: text(form, "seoDescription"),
    displayOrder: Number(text(form, "displayOrder") || "0"),
    startsAt: text(form, "startsAt"),
    endsAt: text(form, "endsAt"),
    productIds: text(form, "productIds")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  });
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the collection." };
  try {
    const saved = await saveCollection(await actor(), parsed.data, id || undefined);
    refresh(["/admin/collections", `/admin/collections/${saved.id}`]);
    return { ok: true, id: saved.id, message: "Collection saved." };
  } catch (error) {
    return fail(error);
  }
}

export async function saveSupplierMappingAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  const productId = text(form, "productId");
  const variants = ids(form, "variantId").map((variantId) => ({
    variantId,
    supplierVariantId: text(form, `supplierVariant:${variantId}`),
    supplierSku: emptyText(text(form, `supplierSku:${variantId}`)),
  }));
  try {
    await saveSupplierMapping(await actor(), productId, {
      supplierProductId: text(form, "supplierProductId"),
      variants,
    });
    refresh([`/admin/products/${productId}`]);
    return { ok: true, message: "Supplier identifiers saved. No supplier was contacted." };
  } catch (error) {
    return fail(error);
  }
}

function emptyText(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

export async function createColorAction(_prev: CatalogActionResult | null, form: FormData): Promise<CatalogActionResult> {
  try {
    await createColor(await actor(), text(form, "name"), text(form, "hex"));
    refresh(["/admin/products"]);
    return { ok: true, message: "Color added to the catalog." };
  } catch (error) {
    if (error instanceof ValidationError) return fail(error);
    return fail(error);
  }
}
