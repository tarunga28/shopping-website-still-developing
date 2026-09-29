"use client";

import { ChevronLeft, ChevronRight, ImageOff, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { STOREFRONT_EVENTS, trackStorefrontEvent } from "@/lib/analytics";
import type { PdpImageDTO } from "@/lib/catalog/pdp-dto";
import { cn } from "@/lib/utils";

const SWIPE_DISTANCE = 48;
const MAIN_SIZES = "(min-width: 1024px) 50vw, 100vw";

function useImageStatus() {
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  return {
    loaded,
    failed,
    markLoaded: (url: string) => setLoaded((prev) => new Set(prev).add(url)),
    markFailed: (url: string) => setFailed((prev) => new Set(prev).add(url)),
  };
}

function Unavailable({ label, className }: { label: string; className?: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("flex h-full w-full flex-col items-center justify-center gap-2 bg-sand text-smoke", className)}
    >
      <ImageOff className="size-7" aria-hidden />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Image unavailable</span>
    </div>
  );
}

/**
 * Product image gallery: main image, thumbnails, previous/next, swipe,
 * arrow-key navigation, zoom lightbox, per-image loading and failure states.
 * The viewport has a fixed 4:5 aspect ratio so nothing shifts while images
 * load; only the first image is `priority`, the rest load lazily.
 */
export function ProductGallery({
  images,
  productName,
  productSlug,
}: {
  images: readonly PdpImageDTO[];
  productName: string;
  productSlug: string;
}) {
  const [index, setIndex] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const status = useImageStatus();
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const swiped = useRef(false);

  const count = images.length;
  const current = images[index] ?? images[0];

  const go = useCallback(
    (next: number, track = true) => {
      if (count < 2) return;
      const wrapped = (next + count) % count;
      setIndex(wrapped);
      setZoomed(false);
      if (track) {
        trackStorefrontEvent({
          name: STOREFRONT_EVENTS.PRODUCT_IMAGE_VIEWED,
          consent: "analytics",
          payload: { slug: productSlug, position: wrapped + 1 },
        });
      }
    },
    [count, productSlug],
  );

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === "mouse") return;
    swipe.current = { x: event.clientX, y: event.clientY };
    swiped.current = false;
  }

  function onPointerUp(event: PointerEvent) {
    const start = swipe.current;
    swipe.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) >= SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      swiped.current = true;
      go(dx < 0 ? index + 1 : index - 1);
    }
  }

  if (!current) {
    return (
      <div className="aspect-[4/5] w-full overflow-hidden rounded-card border-[1.5px] border-clay">
        <div
          role="img"
          aria-label={`${productName} – photos coming soon`}
          className="flex h-full w-full flex-col items-center justify-center gap-2 bg-sand text-smoke"
        >
          <ImageOff className="size-7" aria-hidden />
          <span className="font-mono text-[10px] uppercase tracking-[0.18em]">Photos coming soon</span>
        </div>
      </div>
    );
  }

  const isFailed = status.failed.has(current.url);
  const isLoaded = status.loaded.has(current.url);

  return (
    <div
      className="flex flex-col gap-3"
      role="group"
      aria-roledescription="carousel"
      aria-label={`${productName} images`}
      onKeyDown={onKeyDown}
    >
      <div className="relative aspect-[4/5] w-full touch-pan-y select-none overflow-hidden rounded-card border-[1.5px] border-clay bg-sand">
        {isFailed ? (
          <Unavailable label={`${current.alt} (image unavailable)`} />
        ) : (
          <>
            <span
              aria-hidden
              className={cn(
                "absolute inset-0 z-10 animate-pulse bg-sand transition-opacity duration-300",
                isLoaded && "pointer-events-none opacity-0",
              )}
            />
            <button
              type="button"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onClick={() => {
                if (swiped.current) {
                  swiped.current = false;
                  return;
                }
                setLightbox(true);
              }}
              aria-label={`Zoom image: ${current.alt}`}
              className="absolute inset-0 block cursor-zoom-in focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-flame"
            >
              <Image
                key={current.url}
                src={current.url}
                alt={current.alt}
                fill
                priority={index === 0}
                loading={index === 0 ? undefined : "lazy"}
                sizes={MAIN_SIZES}
                draggable={false}
                onLoad={() => status.markLoaded(current.url)}
                onError={() => status.markFailed(current.url)}
                className="object-cover"
              />
            </button>
          </>
        )}

        <span className="pointer-events-none absolute right-3 top-3 z-20 rounded-pill bg-paper/90 p-2 text-ink" aria-hidden>
          <Maximize2 className="size-4" />
        </span>

        {count > 1 ? (
          <>
            <button
              type="button"
              onClick={() => go(index - 1)}
              aria-label="Previous image"
              className="absolute left-3 top-1/2 z-20 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper/95 text-ink transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
            >
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              aria-label="Next image"
              className="absolute right-3 top-1/2 z-20 flex size-10 -translate-y-1/2 items-center justify-center rounded-pill border-[1.5px] border-ink bg-paper/95 text-ink transition-colors hover:bg-ink hover:text-paper focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame"
            >
              <ChevronRight className="size-5" aria-hidden />
            </button>
            <p className="absolute bottom-3 left-3 z-20 rounded-pill bg-paper/90 px-2.5 py-1 font-mono text-[10px] tracking-[0.14em] text-ink">
              <span aria-live="polite">
                {index + 1} / {count}
              </span>
            </p>
          </>
        ) : null}
      </div>

      {count > 1 ? (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Choose image">
          {images.map((image, position) => {
            const active = position === index;
            return (
              <li key={`${image.url}-${position}`} className="shrink-0">
                <button
                  type="button"
                  onClick={() => go(position)}
                  aria-label={`Show image ${position + 1} of ${count}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "relative block size-16 overflow-hidden rounded-xl border-[1.5px] bg-sand transition-colors sm:size-20",
                    active ? "border-ink" : "border-clay hover:border-smoke",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-flame",
                  )}
                >
                  {status.failed.has(image.url) ? (
                    <ImageOff className="absolute inset-0 m-auto size-4 text-smoke" aria-hidden />
                  ) : (
                    <Image
                      src={image.url}
                      alt=""
                      fill
                      loading="lazy"
                      sizes="80px"
                      onError={() => status.markFailed(image.url)}
                      className="object-cover"
                    />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      <Dialog open={lightbox} onOpenChange={(open) => { setLightbox(open); if (!open) setZoomed(false); }}>
        <DialogContent
          className="flex max-h-[92vh] w-[calc(100vw-1rem)] max-w-5xl flex-col gap-3 rounded-2xl p-3 sm:p-4"
          onKeyDown={onKeyDown}
        >
          <DialogTitle className="pr-10 text-base">{productName}</DialogTitle>
          <DialogDescription className="sr-only">
            Enlarged product image {index + 1} of {count}. Use the arrow keys to move between images.
          </DialogDescription>
          <div className="relative min-h-0 flex-1 overflow-auto rounded-xl bg-sand">
            {isFailed ? (
              <div className="aspect-[4/5] max-h-[70vh] w-full">
                <Unavailable label={`${current.alt} (image unavailable)`} />
              </div>
            ) : (
              <div
                className={cn(
                  "relative mx-auto aspect-[4/5] max-h-[70vh] transition-[width] duration-300",
                  zoomed ? "w-[200%] max-h-none" : "w-full",
                )}
              >
                <Image
                  src={current.url}
                  alt={current.alt}
                  fill
                  sizes={zoomed ? "200vw" : "(min-width: 1024px) 60vw, 100vw"}
                  onError={() => status.markFailed(current.url)}
                  className="object-contain"
                />
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => go(index - 1)}
              disabled={count < 2}
              aria-label="Previous image"
              className="flex size-10 items-center justify-center rounded-pill border-[1.5px] border-ink transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
            >
              <ChevronLeft className="size-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setZoomed((value) => !value)}
              aria-pressed={zoomed}
              className="inline-flex h-10 items-center gap-2 rounded-pill border-[1.5px] border-ink px-4 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors hover:bg-ink hover:text-paper"
            >
              {zoomed ? <ZoomOut className="size-4" aria-hidden /> : <ZoomIn className="size-4" aria-hidden />}
              {zoomed ? "Zoom out" : "Zoom in"}
            </button>
            <button
              type="button"
              onClick={() => go(index + 1)}
              disabled={count < 2}
              aria-label="Next image"
              className="flex size-10 items-center justify-center rounded-pill border-[1.5px] border-ink transition-colors hover:bg-ink hover:text-paper disabled:opacity-40"
            >
              <ChevronRight className="size-5" aria-hidden />
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
