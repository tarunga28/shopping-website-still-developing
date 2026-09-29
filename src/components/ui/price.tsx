import { cn } from "@/lib/utils";
import { formatPrice } from "@/lib/format";

interface PriceProps {
  /** Amount in the smallest currency unit (paise). */
  amount: number;
  compareAt?: number;
  className?: string;
  /** Larger display treatment for PDP hero prices. */
  size?: "sm" | "md" | "lg";
}

const sizeStyles = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-xl",
} as const;

export function Price({ amount, compareAt, className, size = "md" }: PriceProps) {
  const onSale = typeof compareAt === "number" && compareAt > amount;
  return (
    <span className={cn("inline-flex items-baseline gap-2 font-mono tracking-tight", sizeStyles[size], className)}>
      <span className="font-medium">{formatPrice(amount)}</span>
      {onSale ? (
        <>
          <s className="text-smoke/70">{formatPrice(compareAt!)}</s>
          <span className="sr-only">on sale</span>
        </>
      ) : null}
    </span>
  );
}
