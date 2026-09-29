/**
 * Pure variant-selection logic for the product page. Shared by the server
 * (initial state from the URL) and the client (live selection) so both agree.
 *
 * The product's real variants are the only source of truth: a combination
 * that has no variant can never be selected, and nothing is assumed to exist
 * (a mug has no size, a poster may have no colour, a tee has both).
 */

export type VariantState = "AVAILABLE" | "OUT_OF_STOCK" | "UNAVAILABLE";

export interface SelectableVariant {
  id: string;
  color: string | null;
  size: string | null;
  state: VariantState;
}

/** Selected option keys (see `optionKey`). Null = the product has no such option. */
export interface Selection {
  color: string | null;
  size: string | null;
}

export type OptionState = VariantState | "MISSING";

/** Case/whitespace-insensitive identity of a colour or size label. */
export function optionKey(value: string | null | undefined): string | null {
  const key = value?.trim().toLowerCase();
  return key ? key : null;
}

function matches(variant: SelectableVariant, selection: Selection): boolean {
  return optionKey(variant.color) === selection.color && optionKey(variant.size) === selection.size;
}

export function selectionOf(variant: SelectableVariant | undefined): Selection {
  return variant ? { color: optionKey(variant.color), size: optionKey(variant.size) } : { color: null, size: null };
}

export function findVariant<T extends SelectableVariant>(variants: readonly T[], selection: Selection): T | null {
  return variants.find((variant) => matches(variant, selection)) ?? null;
}

const isAvailable = (variant: SelectableVariant) => variant.state === "AVAILABLE";

/** First orderable variant (display order), else the first variant, else nothing. */
export function defaultSelection(variants: readonly SelectableVariant[]): Selection {
  return selectionOf(variants.find(isAvailable) ?? variants[0]);
}

/**
 * Initial selection from untrusted `?color=&size=` values. Anything that does
 * not match a real, orderable variant is ignored — never an error.
 */
export function selectionFromParams(
  variants: readonly SelectableVariant[],
  params: { color?: string | null; size?: string | null },
): Selection {
  const color = optionKey(params.color);
  const size = optionKey(params.size);
  const colorKnown = color !== null && variants.some((variant) => optionKey(variant.color) === color);
  const sizeKnown = size !== null && variants.some((variant) => optionKey(variant.size) === size);

  const pool = variants.filter(
    (variant) =>
      isAvailable(variant) &&
      (!colorKnown || optionKey(variant.color) === color) &&
      (!sizeKnown || optionKey(variant.size) === size),
  );
  if (pool.length > 0 && (colorKnown || sizeKnown)) return selectionOf(pool[0]);

  if (colorKnown) {
    const inColor = variants.filter((variant) => isAvailable(variant) && optionKey(variant.color) === color);
    if (inColor.length > 0) return selectionOf(inColor[0]);
  }
  if (sizeKnown) {
    const inSize = variants.filter((variant) => isAvailable(variant) && optionKey(variant.size) === size);
    if (inSize.length > 0) return selectionOf(inSize[0]);
  }
  return defaultSelection(variants);
}

function pick<T extends SelectableVariant>(
  candidates: readonly T[],
  keepKey: "size" | "color",
  current: Selection,
): T | undefined {
  const keepValue = current[keepKey];
  const keep = (variant: T) => optionKey(variant[keepKey]) === keepValue;
  return (
    candidates.find((variant) => keep(variant) && isAvailable(variant)) ??
    candidates.find(isAvailable) ??
    candidates.find(keep) ??
    candidates[0]
  );
}

/** Choose a colour; keep the current size when that combination exists, else move to the nearest real one. */
export function selectColor(variants: readonly SelectableVariant[], current: Selection, color: string): Selection {
  const key = optionKey(color);
  const candidates = variants.filter((variant) => optionKey(variant.color) === key);
  const chosen = pick(candidates, "size", current);
  return chosen ? selectionOf(chosen) : current;
}

export function selectSize(variants: readonly SelectableVariant[], current: Selection, size: string): Selection {
  const key = optionKey(size);
  const candidates = variants.filter((variant) => optionKey(variant.size) === key);
  const chosen = pick(candidates, "color", current);
  return chosen ? selectionOf(chosen) : current;
}

const RANK: Record<VariantState, number> = { AVAILABLE: 0, OUT_OF_STOCK: 1, UNAVAILABLE: 2 };

/** Colour swatch state: best state among that colour's variants (any size). */
export function colorOptionState(variants: readonly SelectableVariant[], color: string): OptionState {
  const key = optionKey(color);
  let best: OptionState = "MISSING";
  for (const variant of variants) {
    if (optionKey(variant.color) !== key) continue;
    if (best === "MISSING" || RANK[variant.state] < RANK[best]) best = variant.state;
  }
  return best;
}

/** Size state for the currently selected colour; a size that colour lacks is MISSING. */
export function sizeOptionState(variants: readonly SelectableVariant[], selection: Selection, size: string): OptionState {
  const match = findVariant(variants, { color: selection.color, size: optionKey(size) });
  return match ? match.state : "MISSING";
}

export const isSelectable = (state: OptionState): boolean => state === "AVAILABLE";

/** Clean, shareable query for the current selection. Canonical URL never includes it. */
export function selectionToQuery(selection: Selection): string {
  const params = new URLSearchParams();
  if (selection.color) params.set("color", selection.color);
  if (selection.size) params.set("size", selection.size);
  return params.toString();
}
