import type { PdpImageDTO } from "./pdp-dto";

/**
 * Images to show for the selected colour: that colour's own photos first, then
 * the shared ones. A colour with no photo of its own keeps the shared gallery
 * (the image never changes just because the option changed). If EVERY image is
 * colour-specific and this colour has none, show them all rather than nothing.
 */
export function galleryImagesFor(images: readonly PdpImageDTO[], colorKey: string | null): PdpImageDTO[] {
  const shared = images.filter((image) => image.colorKey === null);
  const own = colorKey ? images.filter((image) => image.colorKey === colorKey) : [];
  if (own.length > 0) return [...own, ...shared];
  return shared.length > 0 ? shared : [...images];
}
