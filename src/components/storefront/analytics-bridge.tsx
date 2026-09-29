"use client";

import { useEffect } from "react";
import { trackFromDataset } from "@/lib/analytics";

/**
 * One listener for `data-track` links. No third-party script is loaded.
 * Events are dropped unless a sink is registered and consent allows them.
 */
export function AnalyticsBridge() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tracked = target.closest("[data-track]");
      if (!tracked) return;
      trackFromDataset(tracked);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return null;
}
