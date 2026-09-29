const items = [
  "Original art",
  "Printed on demand",
  "Zero waste",
  "Premium blanks",
  "Ships pan-India",
  "Made to order",
];

/** Seamless scrolling ticker — pure CSS animation, duplicated track. */
export function Marquee() {
  const track = [...items, ...items];
  return (
    <div className="overflow-hidden border-b-[1.5px] border-ink bg-flame" aria-hidden>
      <div className="flex w-max animate-marquee py-3 motion-reduce:animate-none hover:[animation-play-state:paused]">
        {track.map((item, index) => (
          <span
            key={index}
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
