/** Small pagination helpers shared by account listings. */

export const DEFAULT_PAGE_SIZE = 10;

export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePage(
  pageParam: string | string[] | undefined,
  pageSize = DEFAULT_PAGE_SIZE,
): PageParams {
  const raw = Array.isArray(pageParam) ? pageParam[0] : pageParam;
  const parsed = Number.parseInt(String(raw ?? "1"), 10);
  const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 10_000) : 1;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageCount(total: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
