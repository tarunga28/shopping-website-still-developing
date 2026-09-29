import { z } from "zod";

/**
 * Newsletter signup validation.
 * `company` is a honeypot: real users never fill it, bots usually do.
 */
export const newsletterSignupSchema = z.object({
  email: z
    .string()
    .trim()
    .min(3, "Please enter your email address.")
    .max(254, "That email address looks too long.")
    .pipe(z.email({ message: "Please enter a valid email address." })),
  /** Honeypot — any value at all identifies a bot; handled silently in the route. */
  company: z.string().max(120).optional(),
  source: z.enum(["footer", "homepage", "popup"]).default("homepage"),
});

export type NewsletterSignupInput = z.infer<typeof newsletterSignupSchema>;

/** src for future validators: products, addresses, checkout, coupons. */
