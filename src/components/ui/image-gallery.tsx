"use client";

import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Image gallery primitive for future product detail pages:
 * main stage + keyboard-accessible thumbnail strip.
 */
export function ImageGallery({ images, alt }: { images: string[]; alt: string }) {
  const [active, setActive] = useState(0);
  const safeActive = Math.min(active, images.length - 1);

  if (images.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/5] overflow-hidden rounded-3xl border-[1.5px] border-clay bg-sand">
        <Image
          key={images[safeActive]}
          src={images[safeActive]}
          alt={`${alt} — image ${safeActive + 1}`}
          fill
          priority
          sizes="(max-width: 768px) 100vw, 50vw"
          className="object-cover"
        />
      </div>
      {images.length > 1 ? (
        <div role="tablist" aria-label={`${alt} images`} className="flex gap-3 overflow-x-auto pb-1">
          {images.map((src, index) => (
            <button
              key={src + index}
              role="tab"
              aria-selected={index === safeActive}
              aria-label={`View image ${index + 1}`}
              onClick={() => setActive(index)}
              className={cn(
                "relative h-20 w-16 shrink-0 overflow-hidden rounded-xl border-[1.5px] transition-all",
                index === safeActive
                  ? "border-flame opacity-100"
                  : "border-clay opacity-60 hover:opacity-100",
              )}
            >
              <Image src={src} alt="" fill sizes="64px" className="object-cover" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
