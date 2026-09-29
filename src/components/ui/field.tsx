"use client";

import { CheckCircle2, CircleAlert } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  useId,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Field — composable form row that wires the accessibility contract for
 * any control it wraps:
 *
 *   label → htmlFor, description/error → aria-describedby,
 *   error → aria-invalid, required → visual indicator + aria-required
 */

interface ControlA11yProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
  required?: boolean;
  invalid?: boolean;
  success?: boolean;
}

export interface FieldProps extends Omit<HTMLAttributes<HTMLDivElement>, "id"> {
  label?: string;
  description?: string;
  error?: string | null;
  success?: string | boolean | null;
  required?: boolean;
  /** Single form control element (Input, Select, Textarea…). */
  children: ReactElement<ControlA11yProps>;
}

export function Field({
  label,
  description,
  error,
  success,
  required = false,
  children,
  className,
  ...props
}: FieldProps) {
  const autoId = useId();
  const controlId = isValidElement(children) && children.props.id ? children.props.id : autoId;
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const successId = `${controlId}-success`;

  const hasError = Boolean(error);
  const hasSuccess = !hasError && Boolean(success);
  const successMessage = typeof success === "string" ? success : undefined;

  const describedBy = [
    description ? descriptionId : null,
    hasError ? errorId : null,
    hasSuccess ? successId : null,
  ]
    .filter(Boolean)
    .join(" ");

  const control = cloneElement(children, {
    id: controlId,
    "aria-describedby": describedBy || undefined,
    "aria-invalid": hasError || undefined,
    "aria-required": required || undefined,
    required,
    invalid: hasError || undefined,
    success: hasSuccess || undefined,
  });

  return (
    <div className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
      {label ? (
        <Label htmlFor={controlId}>
          {label}
          {required ? (
            <span aria-hidden className="ml-1 text-flame">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only">(required)</span> : null}
        </Label>
      ) : null}

      {control}

      {description ? (
        <p id={descriptionId} className="text-xs leading-relaxed text-smoke">
          {description}
        </p>
      ) : null}

      {hasError ? (
        <p id={errorId} role="alert" className="flex items-center gap-1.5 text-xs font-medium text-danger">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      {hasSuccess ? (
        <p id={successId} className="flex items-center gap-1.5 text-xs font-medium text-success">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
          {successMessage ?? "Looks good"}
        </p>
      ) : null}
    </div>
  );
}

/** Grouped radio-like choices share one legend. */
export function Fieldset({
  legend,
  description,
  children,
  className,
}: {
  legend: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cn("flex flex-col gap-3", className)}>
      <legend className="text-[11px] font-semibold uppercase tracking-[0.14em] text-smoke">
        {legend}
      </legend>
      {description ? <p className="text-xs text-smoke">{description}</p> : null}
      {children}
    </fieldset>
  );
}
