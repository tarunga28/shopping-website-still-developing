import { z } from "zod";
import { emailSchema, phoneSchema } from "@/validations/auth";

/**
 * Account-domain validation — enforced on the server (mirrored in the
 * client only for feedback speed).
 */

/* Indian addresses are first-class; model stays international-ready. */
export const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Delhi (NCT)", "Goa", "Gujarat", "Haryana", "Himachal Pradesh",
  "Jammu & Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Madhya Pradesh",
  "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Puducherry", "Chandigarh",
  "Andaman & Nicobar Islands", "Dadra & Nagar Haveli and Daman & Diu", "Lakshadweep",
] as const;

export const addressSchema = z.object({
  fullName: z.string().trim().min(2, "Enter the recipient's full name.").max(80, "Keep the name under 80 characters."),
  phone: z
    .string()
    .trim()
    .min(10, "Enter a valid phone number.")
    .max(16, "That phone number looks too long.")
    .regex(/^\+?[0-9\s-]{10,16}$/, "Enter a valid phone number with country code."),
  addressLine1: z.string().trim().min(4, "Enter your street address.").max(120),
  addressLine2: z.string().trim().max(120).optional().or(z.literal("")),
  landmark: z.string().trim().max(120).optional().or(z.literal("")),
  city: z.string().trim().min(2, "Enter your city.").max(60),
  state: z.string().trim().min(2, "Select your state.").max(60),
  postalCode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code."),
  country: z.string().trim().length(2).default("IN"),
  label: z.enum(["HOME", "WORK", "OTHER"]).default("HOME"),
  isDefault: z.boolean().default(false),
});

export const emailChangeRequestSchema = z.object({
  newEmail: emailSchema,
});

export const deactivateAccountSchema = z.object({
  password: z.string().min(1, "Enter your current password to confirm."),
  reason: z.string().trim().max(300).optional().or(z.literal("")),
});

export const preferencesSchema = z.object({
  marketingEmails: z.boolean(),
  orderNotifications: z.boolean(),
  promotionalNotifications: z.boolean(),
  language: z.enum(["en-IN", "hi-IN"]).default("en-IN"),
  currency: z.literal("INR"),
});

export const avatarMetaSchema = z.object({
  type: z.enum(["image/jpeg", "image/png", "image/webp"], {
    message: "Use a JPG, PNG or WebP image.",
  }),
  size: z.number().max(2 * 1024 * 1024, "Keep the image under 2 MB."),
});

export type AddressInput = z.infer<typeof addressSchema>;
export type PreferencesInput = z.infer<typeof preferencesSchema>;

/** Loose international phone check used by the profile page. */
export const internationalPhoneSchema = phoneSchema;
