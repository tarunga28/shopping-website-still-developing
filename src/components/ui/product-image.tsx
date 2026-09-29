"use client";

import { ImageOff } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Product image system — responsive next/image with loading shimmer,
 * graceful error fallback and optional hover-swap (second angle).
 */

const aspectRatioStyles = {
  "1:1": "aspect-square",
  "4:5": "aspect-[4/5]",
  "3:4": "aspect-[3/4]",
  "16:10": "aspect-[16/10]",
} as const;

export interface ProductImageProps {
  src: string;
  alt: string;
  /** Optional second view shown while the surrounding group is hovered. */
  hoverSrc?: string;
  ratio?: keyof typeof aspectRatioStyles;
  sizes?: string;
  priority?: boolean;
  className?: string;
  imageClassName?: string;
  rounded?: string;
}

export function ProductImage({
  src,
  alt,
  hoverSrc,
  ratio = "4:5",
  sizes = "(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw",
  priority = false,
  className,
  imageClassName,
  rounded = "rounded-card",
}: ProductImageProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div
        role="img"
        aria-label={`${alt} (image unavailable)`}
        className={cn(
          "flex items-center justify-center border-[1.5px] border-clay bg-sand text-smoke",
          aspectRatioStyles[ratio],
          rounded,
          className,
        )}
      >
        <span className="flex flex-col items-center gap-2">
          <ImageOff className="size-6" aria-hidden />
          <span className="font-mono text-[9px] uppercase tracking-[0.18em]">Image unavailable</span>
        </span>
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden border-[1.5px] border-clay bg-sand", aspectRatioStyles[ratio], rounded, className)}>
      {/* Loading shimmer until the image paints */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 z-10 animate-pulse bg-sand transition-opacity duration-500",
          loaded && "opacity-0",
        )}
      />
      <Image
        src={src}
        alt={alt}
        fill
        priority={priority}
        sizes={sizes}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        className={cn(
          "object-cover transition-all duration-700 ease-out",
          hoverSrc ? "group-hover:opacity-0" : "group-hover:scale-[1.05]",
          imageClassName,
        )}
      />
      {hoverSrc ? (
        <Image
          src={hoverSrc}
          alt=""
          fill
          sizes={sizes}
          aria-hidden
          className="scale-[1.04] object-cover opacity-0 transition-all duration-700 ease-out group-hover:scale-100 group-hover:opacity-100"
        />
      ) : null}
    </div>
  );
}
