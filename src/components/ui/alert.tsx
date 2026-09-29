import { cva, type VariantProps } from "class-variance-authority";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const alertVariants = cva(
  "flex w-full items-start gap-3 rounded-2xl border-[1.5px] p-4 text-sm",
  {
    variants: {
      variant: {
        info: "border-clay bg-cream text-ink",
        success: "border-success/50 bg-success/10 text-ink",
        warning: "border-warning/50 bg-warning/10 text-ink",
        error: "border-danger/50 bg-danger/10 text-ink",
      },
    },
    defaultVariants: { variant: "info" },
  },
);

const icons = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
} as const;

const iconTones = {
  info: "text-smoke",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
} as const;

export interface AlertProps extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}

export function Alert({ className, variant = "info", title, children, ...props }: AlertProps) {
  const Icon = icons[variant ?? "info"];
  return (
    <div role={variant === "error" ? "alert" : "status"} className={cn(alertVariants({ variant }), className)} {...props}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconTones[variant ?? "info"])} aria-hidden />
      <div className="space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="text-sm leading-relaxed text-ink/80">{children}</div>
      </div>
    </div>
  );
}
