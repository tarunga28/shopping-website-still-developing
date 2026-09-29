import { siteConfig } from "@/config/site";

/**
 * Money is stored as an integer in the smallest currency unit
 * (paise for INR) so calculations never hit float drift.
 */

export function formatPrice(
  amountInMinorUnit: number,
  options: { currency?: string; locale?: string; withDecimals?: boolean } = {},
): string {
  const {
    currency = siteConfig.commerce.currency,
    locale = siteConfig.commerce.locale,
    withDecimals = false,
  } = options;

  const major = amountInMinorUnit / 10 ** siteConfig.commerce.currencyFractionDigits;

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: withDecimals ? siteConfig.commerce.currencyFractionDigits : 0,
    maximumFractionDigits: withDecimals ? siteConfig.commerce.currencyFractionDigits : 0,
  }).format(major);
}

/** "from ₹499" style label used on category tiles. */
export function formatFromPrice(amountInMinorUnit: number): string {
  return `from ${formatPrice(amountInMinorUnit)}`;
}

export function formatDate(
  date: Date | string,
  options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" },
): string {
  const value = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(siteConfig.commerce.locale, options).format(value);
}
