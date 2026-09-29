import { z } from "zod";
import { DESIGN_PLACEMENTS, PRODUCT_STATUSES, PRODUCT_TYPES } from "@/lib/catalog-rules";

const moneyInput = z.string().trim().max(16);
const optionalMoney = z.string().trim().max(16).optional().or(z.literal(""));
const id = z.string().uuid();
const slugInput = z
  .string()
  .trim()
  .toLowerCase()
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use a lowercase URL-safe slug.");

export const productWriteSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters.").max(160),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  shortDescription: z.string().trim().max(280).optional().or(z.literal("")),
  description: z.string().trim().max(8000).optional().or(z.literal("")),
  productType: z.enum(PRODUCT_TYPES),
  categoryIds: z.array(id).max(12).default([]),
  primaryCategoryId: id.optional().or(z.literal("")),
  collectionIds: z.array(id).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  basePrice: moneyInput,
  compareAt: optionalMoney,
  currency: z.literal("INR").default("INR"),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  adminNotes: z.string().trim().max(2000).optional().or(z.literal("")),
  estimatedShipping: optionalMoney,
  estimatedPaymentFee: optionalMoney,
  supplierMappingRequired: z.boolean().default(false),
  designId: id.optional().or(z.literal("")),
  placement: z.enum(DESIGN_PLACEMENTS).default("FRONT"),
});

export const variantWriteSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[A-Z0-9][A-Z0-9-]*$/, "SKU must be uppercase letters, numbers, and hyphens."),
  name: z.string().trim().min(1).max(80),
  size: z.string().trim().max(16).optional().or(z.literal("")),
  color: z.string().trim().max(40).optional().or(z.literal("")),
  price: moneyInput,
  compareAt: optionalMoney,
  availability: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"]),
  weightGrams: z.number().int().positive().max(20000).nullable().optional(),
});

export const categoryWriteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  parentId: id.optional().or(z.literal("")),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  displayOrder: z.number().int().min(0).max(9999).default(0),
});

export const collectionWriteSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z.string().trim().max(80).optional().or(z.literal("")),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("DRAFT"),
  seoTitle: z.string().trim().max(70).optional().or(z.literal("")),
  seoDescription: z.string().trim().max(160).optional().or(z.literal("")),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  startsAt: z.string().trim().max(40).optional().or(z.literal("")),
  endsAt: z.string().trim().max(40).optional().or(z.literal("")),
  productIds: z.array(id).max(200).default([]),
});

export const bulkSchema = z.object({
  action: z.enum(["ARCHIVE", "PUBLISH", "ADD_COLLECTION", "REMOVE_COLLECTION", "CHANGE_CATEGORY"]),
  productIds: z.array(id).min(1).max(100),
  confirmation: z.string().trim().max(40),
  categoryId: id.optional(),
  collectionId: id.optional(),
});

export const catalogQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  category: slugInput.optional(),
  collection: slugInput.optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  minPricePaise: z.number().int().nonnegative().optional(),
  maxPricePaise: z.number().int().nonnegative().optional(),
  color: z.string().trim().max(40).optional(),
  size: z.string().trim().max(16).optional(),
  availability: z.enum(["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK", "PREORDER"]).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  tag: slugInput.optional(),
  sort: z.enum(["newest", "oldest", "price-asc", "price-desc", "name", "popularity"]).optional(),
  page: z.number().int().positive().optional(),
  pageSize: z.union([z.literal(20), z.literal(50), z.literal(100)]).optional(),
});

export type ProductWriteInput = z.infer<typeof productWriteSchema>;
export type VariantWriteInput = z.infer<typeof variantWriteSchema>;
export type CategoryWriteInput = z.infer<typeof categoryWriteSchema>;
export type CollectionWriteInput = z.infer<typeof collectionWriteSchema>;
export type BulkInput = z.infer<typeof bulkSchema>;
