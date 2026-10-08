import { createHmac } from "node:crypto";

import { clientIp } from "@/lib/rate-limit";

/**
 * A salted, non-reversible session identifier for search analytics.
 *
 * ## Why not just store the IP or the user id
 *
 * Search logs are the most casually-collected data in the system, and the most
 * tempting to over-collect. A raw IP in a search log is personal data under most
 * privacy regimes, and a user id links every query a person ever typed to their
 * account forever. Neither is needed to answer the questions analytics asks:
 * "how many distinct sessions searched this?", "did this session click?".
 *
 * So the log gets an HMAC of (identifier, per-install salt). It is stable for a
 * session — which is what grouping needs — and reveals nothing, because the salt
 * is secret and the output is not invertible.
 *
 * ## What is hashed
 *
 * A signed-in user's id, or the client IP for an anonymous visitor. The IP case
 * is the weaker one: two people behind one NAT share a hash. That is accepted,
 * because the alternative (storing the IP) is worse, and the analytics that
 * matters is not sensitive to it.
 */
export function searchSessionHash(
  input: { userId?: string | null; request?: Request },
  salt?: string | null,
): string {
  const secret =
    salt ??
    process.env.SEARCH_SESSION_SALT ??
    // A fallback keeps local development working without configuration. It is
    // not secret, which is fine locally and unacceptable in production — hence
    // the documented environment variable.
    "inkline-dev-search-salt";

  const subject = input.userId?.trim() || (input.request ? clientIp(input.request) : "") || "anonymous";

  return createHmac("sha256", secret).update(subject).digest("hex").slice(0, 32);
}

/**
 * True when a request looks automated.
 *
 * Deliberately narrow. The goal is to keep a crawler's 10,000 identical queries
 * out of the trending list, not to fingerprint visitors. Anything this cannot
 * classify confidently is treated as human, because under-counting a trend is a
 * small error and hiding real demand is a large one.
 */
export function looksLikeBot(request: Request): boolean {
  const userAgent = request.headers.get("user-agent") ?? "";
  if (!userAgent) return true;

  const lower = userAgent.toLowerCase();
  const botMarkers = [
    "bot",
    "crawler",
    "spider",
    "curl",
    "wget",
    "python-requests",
    "httpclient",
    "scrapy",
    "headlesschrome",
    "phantomjs",
    "lighthouse",
  ];
  return botMarkers.some((marker) => lower.includes(marker));
}
