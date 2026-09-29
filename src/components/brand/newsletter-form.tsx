"use client";

import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost, ApiClientError } from "@/lib/api-client";
import { trackStorefrontEvent, STOREFRONT_EVENTS } from "@/lib/analytics";
import { cn } from "@/lib/utils";

interface NewsletterResponse {
  status: "subscribed" | "already_subscribed";
  listSync?: { synced: boolean; provider: string };
}

type FormStatus = "idle" | "pending" | "subscribed" | "already_subscribed" | "invalid" | "error";

const messages: Record<Exclude<FormStatus, "idle" | "pending">, string> = {
  subscribed: "You're on the Inkline list. We stored your email here — that is the subscription.",
  already_subscribed: "This address is already on the list.",
  invalid: "Enter a valid email address.",
  error: "We couldn't save that just now. Please try again.",
};

/**
 * Newsletter capture. Success means the address was stored by our API.
 * It does not claim an external marketing platform received it.
 */
export function NewsletterForm({
  source,
  tone = "flame",
  layout = "inline",
  className,
}: {
  source: "homepage" | "footer";
  tone?: "flame" | "ink";
  layout?: "inline" | "stacked";
  className?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<FormStatus>("idle");
  const [detail, setDetail] = useState<string | null>(null);
  const id = `newsletter-email-${source}`;
  const messageId = `${id}-status`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "pending") return;

    const form = new FormData(event.currentTarget);
    if (String(form.get("company") ?? "").trim()) {
      setStatus("subscribed");
      setDetail(messages.subscribed);
      setEmail("");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setStatus("invalid");
      setDetail(messages.invalid);
      return;
    }

    setStatus("pending");
    setDetail(null);
    try {
      const result = await apiPost<NewsletterResponse>("/api/newsletter", { email, source });
      const next = result.status === "already_subscribed" ? "already_subscribed" : "subscribed";
      setStatus(next);
      setDetail(
        next === "subscribed" && result.listSync?.synced
          ? "You're on the Inkline list, and the connected list provider accepted the address."
          : messages[next],
      );
      if (next === "subscribed") {
        trackStorefrontEvent({
          name: STOREFRONT_EVENTS.NEWSLETTER_SIGNUP,
          consent: "analytics",
          payload: { id: source },
        });
      }
      setEmail("");
    } catch (error) {
      if (error instanceof ApiClientError && (error.code === "VALIDATION_ERROR" || error.status === 422)) {
        setStatus("invalid");
        setDetail(error.message || messages.invalid);
        return;
      }
      setStatus("error");
      setDetail(error instanceof ApiClientError ? error.message : messages.error);
    }
  }

  const announced = status === "idle" || status === "pending" ? undefined : detail;

  return (
    <form onSubmit={onSubmit} className={cn("w-full", className)} noValidate>
      <label htmlFor={id} className="sr-only">
        Email address
      </label>
      <div
        className={cn(
          layout === "inline"
            ? "flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:rounded-pill sm:border-[1.5px] sm:p-1.5 " +
                (tone === "flame" ? "sm:border-ink sm:bg-paper" : "sm:border-paper/40 sm:bg-paper/10")
            : "flex flex-col gap-3",
        )}
      >
        <Input
          id={id}
          type="email"
          inputSize={layout === "inline" ? "lg" : "md"}
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          aria-invalid={status === "invalid" || undefined}
          aria-describedby={announced ? messageId : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (status === "invalid" || status === "error") setStatus("idle");
          }}
          className={
            layout === "inline"
              ? tone === "ink"
                ? "border-paper/40 bg-paper/10 text-paper placeholder:text-paper/50 sm:border-transparent sm:bg-transparent"
                : "sm:border-transparent sm:bg-transparent sm:focus:outline-none"
              : undefined
          }
        />
        <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
        <Button
          type="submit"
          variant={tone === "ink" && layout === "inline" ? "accent" : "primary"}
          size={layout === "inline" ? "lg" : "md"}
          loading={status === "pending"}
          className={layout === "inline" ? "w-full sm:w-auto sm:shrink-0" : "w-full"}
        >
          {status === "pending" ? "Saving…" : "Subscribe"}
          {status !== "pending" && <ArrowRight className="size-4" aria-hidden />}
        </Button>
      </div>
      <p
        id={messageId}
        role="status"
        className={cn(
          "mt-3 min-h-4 text-xs leading-relaxed",
          status === "invalid" || status === "error" ? "text-danger" : tone === "ink" ? "text-paper/80" : "text-ink/80",
        )}
      >
        {announced}
      </p>
    </form>
  );
}
