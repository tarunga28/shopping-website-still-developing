export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** 1-based index of the first / last item on this page. 0 when empty. */
  from: number;
  to: number;
}

export function buildPaginationMeta(input: { page: number; pageSize: number; total: number; count: number }): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(input.total / input.pageSize));
  const from = input.count === 0 ? 0 : (input.page - 1) * input.pageSize + 1;
  const to = input.count === 0 ? 0 : from + input.count - 1;
  return { page: input.page, pageSize: input.pageSize, total: input.total, totalPages, from, to };
}

export type PageItem = number | "ellipsis-start" | "ellipsis-end";

/** [1] … [4] [5] [6] … [10] — always includes first, last and a window around the current page. */
export function buildPageWindow(page: number, totalPages: number, siblings = 1): PageItem[] {
  if (totalPages <= 1) return [1];
  const items: PageItem[] = [];
  const start = Math.max(2, page - siblings);
  const end = Math.min(totalPages - 1, page + siblings);
  items.push(1);
  if (start > 2) items.push("ellipsis-start");
  for (let value = start; value <= end; value += 1) items.push(value);
  if (end < totalPages - 1) items.push("ellipsis-end");
  items.push(totalPages);
  return items;
}
