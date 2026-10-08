import { z } from "zod";

import { apiOk, withErrorHandling } from "@/lib/api-response";
import { catalogApiLimiter, enforceRateLimit } from "@/lib/catalog/api";
import { ValidationError } from "@/lib/errors";
import { requireCatalogEditorApi } from "@/server/auth/catalog-access";
import {
  createSynonym,
  deleteSynonym,
  importSynonyms,
  listSynonyms,
  seedDefaultSynonyms,
  updateSynonym,
} from "@/services/search/synonym.service";

export const dynamic = "force-dynamic";

const limiter = catalogApiLimiter("api-admin-search-synonyms", 60);

const synonymSchema = z.object({
  term: z.string().trim().min(1).max(80),
  synonym: z.string().trim().min(1).max(80),
  // One-way is the safe default: expanding a query is recoverable, silently
  // broadening what a narrow term matches is not.
  isBidirectional: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const importSchema = z.object({
  lines: z.array(z.string().max(200)).min(1).max(2000),
});

/** GET /api/admin/search/synonyms?q=&includeInactive=1 */
export const GET = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const synonyms = await listSynonyms({
    search: url.searchParams.get("q"),
    includeInactive: url.searchParams.get("includeInactive") === "1",
  });

  return apiOk({ synonyms });
}, "api-admin-search-synonyms-get");

/** POST /api/admin/search/synonyms — create one, or `{ lines: [...] }` to import. */
export const POST = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  // Seeding the conservative default set is an explicit action on the same
  // endpoint, so the route module exports only real HTTP handlers.
  const url = new URL(request.url);
  if (url.searchParams.get("action") === "seed") {
    const written = await seedDefaultSynonyms();
    return apiOk({ written });
  }

  // A bulk import is a different shape from a single create, and accepting both
  // on one endpoint saves the admin UI a second route.
  const asImport = importSchema.safeParse(body);
  if (asImport.success) {
    const result = await importSynonyms(asImport.data.lines);
    return apiOk(result);
  }

  const parsed = synonymSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the synonym.");
  }

  const created = await createSynonym(parsed.data);
  return apiOk({ synonym: created }, { status: 201 });
}, "api-admin-search-synonyms-post");

/** PATCH /api/admin/search/synonyms?id=&{...} */
export const PATCH = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError("Invalid synonym id.");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = synonymSchema.partial().safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the synonym.");
  }

  const updated = await updateSynonym(id, parsed.data);
  return apiOk({ synonym: updated });
}, "api-admin-search-synonyms-patch");

/** DELETE /api/admin/search/synonyms?id= */
export const DELETE = withErrorHandling(async (request: Request) => {
  enforceRateLimit(limiter, request);
  await requireCatalogEditorApi();

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError("Invalid synonym id.");

  const removed = await deleteSynonym(id);
  return apiOk({ removed });
}, "api-admin-search-synonyms-delete");
