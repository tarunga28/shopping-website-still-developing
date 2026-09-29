import "server-only";
import { logger } from "@/lib/logger";

/**
 * Marketing-list provider seam.
 *
 * Subscribing on Inkline always means a row in our database. This interface
 * is how a later ESP (Resend audience, Mailchimp, …) can be attached.
 * The default provider does not pretend a sync happened.
 */

export interface NewsletterListSync {
  /** True only when an external provider accepted the address. */
  synced: boolean;
  provider: string;
}

export interface NewsletterListProvider {
  readonly name: string;
  sync(input: { email: string; source: string }): Promise<NewsletterListSync>;
}

class UnconfiguredListProvider implements NewsletterListProvider {
  readonly name = "unconfigured";

  async sync(): Promise<NewsletterListSync> {
    return { synced: false, provider: this.name };
  }
}

/**
 * Placeholder for a future HTTPS provider. It is selected only when
 * NEWSLETTER_LIST_WEBHOOK_URL is set, and it reports failure honestly.
 */
class WebhookListProvider implements NewsletterListProvider {
  readonly name = "webhook";

  constructor(private readonly url: string) {}

  async sync(input: { email: string; source: string }): Promise<NewsletterListSync> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: input.email, source: input.source }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Newsletter list provider responded ${response.status}`);
    }
    return { synced: true, provider: this.name };
  }
}

let cached: NewsletterListProvider | null = null;

export function getNewsletterListProvider(): NewsletterListProvider {
  if (cached) return cached;
  const url = process.env.NEWSLETTER_LIST_WEBHOOK_URL;
  cached = url ? new WebhookListProvider(url) : new UnconfiguredListProvider();
  return cached;
}

export async function syncNewsletterList(input: { email: string; source: string }): Promise<NewsletterListSync> {
  const provider = getNewsletterListProvider();
  try {
    return await provider.sync(input);
  } catch (error) {
    logger.warn("Newsletter list provider sync failed", {
      provider: provider.name,
      message: error instanceof Error ? error.message : "unknown",
    });
    return { synced: false, provider: provider.name };
  }
}
