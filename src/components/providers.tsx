"use client";

import { MotionConfig } from "framer-motion";
import { Toaster } from "sonner";
import type { ReactNode } from "react";
import { AnalyticsBridge } from "@/components/storefront/analytics-bridge";

/**
 * Client-wide providers. Kept deliberately thin: motion preferences +
 * the app toast system, wrapped at the root layout.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <AnalyticsBridge />
      {children}
      <Toaster
        position="bottom-right"
        gap={10}
        toastOptions={{
          className:
            "!rounded-2xl !border-[1.5px] !border-ink !bg-ink !text-paper !shadow-[6px_6px_0_0_var(--color-flame)]",
          classNames: {
            description: "!text-paper/70",
            actionButton: "!bg-flame !text-ink",
          },
        }}
      />
    </MotionConfig>
  );
}
