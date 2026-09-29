"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { defaultConsent, readConsent, writeConsent, type ConsentState } from "@/lib/consent";

/**
 * Preference center. Essential storage stays on. Analytics and marketing
 * can be recorded as a preference, but this control does not load trackers.
 */
export function PrivacyChoices({ tone = "paper" }: { tone?: "paper" | "ink" }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ConsentState>(defaultConsent);
  const [saved, setSaved] = useState(false);

  function onOpen(next: boolean) {
    setOpen(next);
    if (next) {
      setState(readConsent());
      setSaved(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={
            tone === "paper"
              ? "text-sm text-paper/75 transition-colors hover:text-flame"
              : "text-sm text-smoke underline decoration-flame underline-offset-4"
          }
        >
          Privacy choices
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Privacy choices</DialogTitle>
          <DialogDescription>
            Essential cookies keep you signed in and remember theme. Analytics and marketing tools are not loaded.
            Saving a preference here does not start tracking.
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-4 space-y-4">
          <li className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-semibold">Essential</span>
              <span className="mt-1 block text-xs leading-relaxed text-smoke">Session, theme, and dismissing the announcement bar. Always on.</span>
            </span>
            <Switch checked disabled aria-label="Essential cookies, always on" />
          </li>
          <li className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-semibold">Analytics</span>
              <span className="mt-1 block text-xs leading-relaxed text-smoke">Off. No analytics script is included in this storefront.</span>
            </span>
            <Switch
              checked={state.analytics}
              onCheckedChange={(checked) => setState((current) => ({ ...current, analytics: checked }))}
              aria-label="Analytics preference"
            />
          </li>
          <li className="flex items-start justify-between gap-4">
            <span>
              <span className="block text-sm font-semibold">Marketing</span>
              <span className="mt-1 block text-xs leading-relaxed text-smoke">Off. No advertising tags are included.</span>
            </span>
            <Switch
              checked={state.marketing}
              onCheckedChange={(checked) => setState((current) => ({ ...current, marketing: checked }))}
              aria-label="Marketing preference"
            />
          </li>
        </ul>
        <div className="mt-6 flex items-center justify-between gap-3">
          <p className="text-xs text-smoke" role="status">
            {saved ? "Preference saved on this device." : ""}
          </p>
          <Button
            type="button"
            onClick={() => {
              writeConsent({ analytics: state.analytics, marketing: state.marketing });
              setSaved(true);
            }}
          >
            Save choices
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
