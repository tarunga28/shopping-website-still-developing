import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/services/audit.service";

/**
 * Avatar upload — storage-provider architecture.
 *
 * LocalDevStorageProvider (default): persists into `public/uploads/avatars`
 * — real uploaded files served by the app in development/self-hosted.
 * The S3-compatible provider (bucket + presigned PUT) slots into the same
 * interface when the storage milestone lands; configuration is reserved
 * in .env.example (S3_*) and selection happens here.
 *
 * Security contract (enforced before any byte is written):
 *  - allow-listed MIME types only (jpg/png/webp)
 *  - magic-byte sniffed content must match the declared type
 *  - hard size cap (2 MB)
 *  - filename is never trusted — new random key per upload
 */

export interface StoragePutResult {
  url: string;
  key: string;
}

export interface StorageProvider {
  name: string;
  put(key: string, data: Buffer, mimeType: string): Promise<StoragePutResult>;
  remove(urlOrKey: string): Promise<void>;
}

class LocalDevStorageProvider implements StorageProvider {
  name = "local-dev";
  private rootDir = path.join(process.cwd(), "public", "uploads");

  async put(key: string, data: Buffer): Promise<StoragePutResult> {
    const dir = path.join(this.rootDir, "avatars");
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, key);
    await writeFile(target, data);
    return { url: `/uploads/avatars/${key}`, key: `avatars/${key}` };
  }

  async remove(urlOrKey: string): Promise<void> {
    const key = urlOrKey.startsWith("/uploads/") ? urlOrKey.replace("/uploads/", "") : urlOrKey;
    // Containment check — never escape the uploads root.
    const target = path.resolve(this.rootDir, key);
    if (!target.startsWith(path.resolve(this.rootDir) + path.sep)) return;
    await unlink(target).catch(() => undefined);
  }
}

/** Placeholder for the milestone-provided object storage. */
class PendingS3Provider implements StorageProvider {
  name = "s3";
  constructor() {
    const configured = Boolean(process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID);
    if (!configured) {
      throw new AppError("Object storage isn't configured in this environment.", {
        status: 503,
        code: "STORAGE_UNAVAILABLE",
      });
    }
  }
  async put(): Promise<StoragePutResult> {
    throw new AppError("Object storage integration lands with the storage milestone.", {
      status: 501,
      code: "STORAGE_PENDING",
    });
  }
  async remove(): Promise<void> {
    /* no-op */
  }
}

let provider: StorageProvider | null = null;
function getStorage(): StorageProvider {
  if (!provider) {
    // Local dev storage by default; the S3 provider activates when env is set
    // and the storage milestone implements the transport.
    provider = process.env.STORAGE_DRIVER === "s3" ? new PendingS3Provider() : new LocalDevStorageProvider();
  }
  return provider;
}

/* ── Upload pipeline ─────────────────────────────────────────────────── */

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED: Record<string, { ext: string; magic: number[]; mime: string }> = {
  "image/jpeg": { ext: "jpg", magic: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  "image/png": { ext: "png", magic: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  "image/webp": { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" },
};

function sniffMatchesType(buffer: Buffer, mimeType: string): boolean {
  const spec = ALLOWED[mimeType];
  if (!spec) return false;
  if (buffer.length < 12) return false;
  if (mimeType === "image/webp") {
    return (
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
    );
  }
  return spec.magic.every((byte, index) => buffer[index] === byte);
}

export async function uploadAvatar(
  userId: string,
  file: { name: string; type: string; size: number; data: Buffer },
): Promise<{ avatarUrl: string }> {
  if (!ALLOWED[file.type]) {
    throw new AppError("Use a JPG, PNG or WebP image.", { status: 422, code: "AVATAR_TYPE" });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    throw new AppError("Keep the image under 2 MB.", { status: 422, code: "AVATAR_SIZE" });
  }
  if (!sniffMatchesType(file.data, file.type)) {
    throw new AppError("That file doesn't look like a real image.", { status: 422, code: "AVATAR_CONTENT" });
  }

  const key = `${userId}-${randomBytes(6).toString("hex")}.${ALLOWED[file.type].ext}`;
  const storage = getStorage();
  const stored = await storage.put(key, file.data, ALLOWED[file.type].mime);

  // Swap URL on the user, then remove the previous file best-effort.
  const [current] = await db.select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ avatarUrl: stored.url }).where(eq(users.id, userId));
  if (current?.avatarUrl) await storage.remove(current.avatarUrl);

  await writeAudit({
    action: "user.avatar_updated",
    entityType: "user",
    entityId: userId,
    actorId: userId,
    metadata: { storage: storage.name, bytes: file.size },
  });

  return { avatarUrl: stored.url };
}

export async function removeAvatar(userId: string): Promise<void> {
  const [current] = await db.select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, userId)).limit(1);
  await db.update(users).set({ avatarUrl: null }).where(eq(users.id, userId));
  if (current?.avatarUrl) {
    await getStorage()
      .remove(current.avatarUrl)
      .catch((error) => logger.warn("Avatar file cleanup failed", { error: String(error) }));
  }

  await writeAudit({
    action: "user.avatar_removed",
    entityType: "user",
    entityId: userId,
    actorId: userId,
  });
}
