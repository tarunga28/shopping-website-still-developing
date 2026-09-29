"use client";

import { ArrowRight } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost, ApiClientError } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface NewsletterResponse {
  status: "subscribed" | "already_subscribed";
}

/**
 * Reusable newsletter capture — posts to the real /api/newsletter
 * endpoint (validation, rate limiting, dedup, audit trail).
 * Used by the homepage panel and the footer.
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
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const result = await apiPost<NewsletterResponse>("/api/newsletter", { email, source });
      toast.success(
        result.status === "already_subscribed"
          ? "You're already on the list — we'll be in touch."
          : "You're on the list. First drop announcement lands in your inbox.",
      );
      setEmail("");
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : "Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const id = `newsletter-email-${source}`;

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        "w-full",
        layout === "inline"
          ? "flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:rounded-pill sm:border-[1.5px] sm:bg-paper sm:p-1.5 " +
              (tone === "flame" ? "sm:border-ink" : "sm:border-paper/40 sm:bg-paper/10")
          : "flex flex-col gap-3",
        className,
      )}
    >
      <label htmlFor={id} className="sr-only">
        Email address
      </label>
      <Input
        id={id}
        type="email"
        inputSize={layout === "inline" ? "lg" : "md"}
        required
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className={
          layout === "inline"
            ? tone === "ink"
              ? "border-paper/40 bg-paper/10 text-paper placeholder:text-paper/50 sm:border-transparent sm:bg-transparent sm:focus:outline-2"
              : "sm:border-transparent sm:bg-transparent sm:focus:outline-none"
            : undefined
        }
      />
      {/* Honeypot — invisible to humans */}
      <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
      <Button
        type="submit"
        variant={tone === "ink" && layout === "inline" ? "accent" : "primary"}
        size={layout === "inline" ? "lg" : "md"}
        loading={pending}
        className={layout === "inline" ? "sm:shrink-0" : "w-full"}
      >
        {pending ? "Joining…" : "Subscribe"}
        {!pending && <ArrowRight className="size-4" aria-hidden />}
      </Button>
    </form>
  );
}
