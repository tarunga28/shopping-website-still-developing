import { storefrontContent } from "@/content/storefront";

/** Brand ticker. Copy comes from storefront content, not a hard-coded claim list. */
export function Marquee() {
  const items = storefrontContent.marquee;
  const track = [...items, ...items];
  return (
    <div className="overflow-hidden border-b-[1.5px] border-ink bg-flame" aria-hidden>
      <div className="flex w-max animate-marquee py-3 motion-reduce:animate-none">
        {track.map((item, index) => (
          <span
            key={`${item}-${index}`}
            className="flex items-center gap-6 pr-6 font-mono text-xs font-semibold uppercase tracking-[0.22em] text-ink"
          >
            {item}
            <span aria-hidden>✳</span>
          </span>
        ))}
      </div>
    </div>
  );
}
