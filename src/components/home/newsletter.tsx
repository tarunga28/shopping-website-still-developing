"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ArrowRight } from "lucide-react";
import { Section } from "@/components/layout/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiPost, ApiClientError } from "@/lib/api-client";

interface NewsletterResponse {
  status: "subscribed" | "already_subscribed";
}

/**
 * Newsletter capture — posts to the real /api/newsletter endpoint which
 * validates, rate-limits and stores signups in Postgres.
 */
export function Newsletter() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);

    try {
      const result = await apiPost<NewsletterResponse>("/api/newsletter", {
        email,
        source: "homepage",
      });
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

  return (
    <Section id="newsletter" className="py-12 md:py-16">
      <div className="relative overflow-hidden rounded-[2rem] border-[1.5px] border-ink bg-flame px-6 py-12 sm:px-10 md:px-16 md:py-16">
        <span
          aria-hidden
          className="pointer-events-none absolute -right-10 -top-16 select-none font-display text-[16rem] font-extrabold leading-none text-ink/10"
        >
          ✳
        </span>

        <div className="relative grid grid-cols-1 items-center gap-8 lg:grid-cols-2">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-ink/70">
              06 — The drop list
            </p>
            <h2 className="mt-3 font-display text-4xl font-extrabold uppercase leading-[0.95] tracking-tight text-ink sm:text-5xl">
              First dibs on
              <br />
              every drop<span aria-hidden>.</span>
            </h2>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-ink/75 sm:text-base">
              Launch access, artist stories and subscriber-only designs. One good email when it
              matters — never spam.
            </p>
          </div>

          <form onSubmit={onSubmit} className="w-full" noValidate={false}>
            <label htmlFor="newsletter-email" className="sr-only">
              Email address
            </label>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-0 sm:rounded-full sm:border-[1.5px] sm:border-ink sm:bg-paper sm:p-1.5">
              <Input
                id="newsletter-email"
                type="email"
                inputSize="lg"
                required
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="sm:border-transparent sm:bg-transparent sm:focus:outline-none"
              />
              {/* Honeypot — invisible to humans, bots love it. */}
              <input type="text" name="company" tabIndex={-1} autoComplete="off" className="hidden" aria-hidden="true" />
              <Button type="submit" variant="primary" size="lg" loading={pending} className="sm:shrink-0">
                {pending ? "Joining…" : "Join the list"}
                {!pending && <ArrowRight className="size-4" aria-hidden />}
              </Button>
            </div>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.18em] text-ink/60">
              No spam · Unsubscribe anytime · We never sell your data
            </p>
          </form>
        </div>
      </div>
    </Section>
  );
}
