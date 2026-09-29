import { apiOk, withErrorHandling } from "@/lib/api-response";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { clientIp, createRateLimiter } from "@/lib/rate-limit";
import { subscribeToNewsletter } from "@/services/newsletter.service";
import { newsletterSignupSchema } from "@/validations/newsletter";

export const dynamic = "force-dynamic";

/** 5 signups per 10 minutes per IP — abuse control for a public form. */
const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000, namespace: "newsletter" });

export const POST = withErrorHandling(async (request: Request) => {
  const ip = clientIp(request);
  const { success } = limiter.check(ip);
  if (!success) throw new RateLimitError();

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new ValidationError("Invalid request body.");
  }

  const parsed = newsletterSignupSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? "Please check the details you entered.",
    );
  }

  // Honeypot filled → bot. Pretend success, store nothing, reveal nothing.
  if (parsed.data.company) {
    return apiOk({ status: "subscribed" }, { status: 201 });
  }

  const result = await subscribeToNewsletter(parsed.data.email, parsed.data.source, {
    ip,
    userAgent: request.headers.get("user-agent") ?? undefined,
  });

  return apiOk(result, { status: result.status === "subscribed" ? 201 : 200 });
}, "POST /api/newsletter");
