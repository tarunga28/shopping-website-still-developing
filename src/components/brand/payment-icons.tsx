import { cn } from "@/lib/utils";

/**
 * Payment method indicators — typographic brand pills.
 * These are the rails Razorpay will process at launch (UPI, cards on
 * Visa/Mastercard/RuPay networks, and netbanking).
 */

export type PaymentMethod = "upi" | "visa" | "mastercard" | "rupay" | "netbanking";

const methodCopy: Record<PaymentMethod, string> = {
  upi: "UPI",
  visa: "Visa",
  mastercard: "Mastercard",
  rupay: "RuPay",
  netbanking: "NetBanking",
};

function PaymentPill({ method, className }: { method: PaymentMethod; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-current/30 px-2 py-1 font-mono text-[9px] font-medium uppercase tracking-[0.12em] opacity-80",
        className,
      )}
    >
      {methodCopy[method]}
    </span>
  );
}

export function PaymentIcons({
  label = "Accepted payment methods",
  methods = ["upi", "visa", "mastercard", "rupay", "netbanking"],
  className,
}: {
  label?: string;
  methods?: PaymentMethod[];
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} aria-label={label} role="list">
      {methods.map((method) => (
        <span role="listitem" key={method}>
          <PaymentPill method={method} />
        </span>
      ))}
    </div>
  );
}
