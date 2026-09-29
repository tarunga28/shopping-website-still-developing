/**
 * Product image checks. The filename is never trusted.
 * Files over 4 MB are rejected so a 10 MB original is never stored or sent.
 */

const MAX_BYTES = 4 * 1024 * 1024;
const MIN_EDGE = 200;
const MAX_EDGE = 5000;

const ALLOWED = {
  "image/jpeg": { ext: "jpg" },
  "image/png": { ext: "png" },
  "image/webp": { ext: "webp" },
} as const;

export type ProductImageMime = keyof typeof ALLOWED;

export interface InspectedImage {
  mime: ProductImageMime;
  ext: string;
  width: number;
  height: number;
  bytes: number;
}

export function inspectProductImage(buffer: Buffer, declaredMime: string): InspectedImage {
  if (!(declaredMime in ALLOWED)) {
    throw new Error("Use a JPG, PNG, or WebP image.");
  }
  if (buffer.length === 0 || buffer.length > MAX_BYTES) {
    throw new Error("Product images must be under 4 MB.");
  }
  const mime = sniff(buffer);
  if (!mime || mime !== declaredMime) {
    throw new Error("The file contents do not match an allowed image type.");
  }
  const size = dimensions(buffer, mime);
  if (!size) throw new Error("Could not read the image dimensions.");
  if (size.width < MIN_EDGE || size.height < MIN_EDGE || size.width > MAX_EDGE || size.height > MAX_EDGE) {
    throw new Error("Images must be between 200 and 5000 pixels on each side.");
  }
  return { mime, ext: ALLOWED[mime].ext, width: size.width, height: size.height, bytes: buffer.length };
}

function sniff(buffer: Buffer): ProductImageMime | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function dimensions(buffer: Buffer, mime: ProductImageMime): { width: number; height: number } | null {
  if (mime === "image/png") {
    if (buffer.length < 24) return null;
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/jpeg") return jpegSize(buffer);
  return webpSize(buffer);
}

function jpegSize(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1]!;
    const length = buffer.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function webpSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null;
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8X" && buffer.length >= 30) {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return { width, height };
  }
  if (format === "VP8 " && buffer.length >= 30) {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return null;
}
