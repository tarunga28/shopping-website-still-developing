"use client";

import Link from "next/link";
import { Mail } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogContent,
} from "@/components/ui/dialog";
import { siteConfig } from "@/config/site";

/**
 * Honest placeholder used for header actions whose backend lands in a
 * later milestone (cart, wishlist, account). Never fakes functionality —
 * it says what is coming and offers the newsletter + support channel.
 */
export function ComingSoonDialog({
  trigger,
  feature,
  description,
}: {
  trigger: ReactNode;
  feature: string;
  description: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <p className="font-mono text-[10px] font-medium uppercase tracking-[0.22em] text-flame">
            Launching soon
          </p>
          <DialogTitle>{feature}</DialogTitle>
          <DialogDescription className="pt-1 text-smoke">{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild variant="primary" size="md">
            <Link href="/#newsletter">Join the waitlist</Link>
          </Button>
          <Button asChild variant="outline" size="md">
            <a href={`mailto:${siteConfig.contact.email}`}>
              <Mail className="size-4" aria-hidden />
              Email us
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
