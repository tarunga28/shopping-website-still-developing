"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowDown, ArrowRight, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";

const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  visible: (delay: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

/** Rotating circular stamp badge next to the hero artwork. */
function RotatingStamp() {
  return (
    <div className="absolute -left-8 top-8 hidden size-28 animate-[spin_18s_linear_infinite] md:block lg:size-32" aria-hidden>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <circle cx="50" cy="50" r="50" className="fill-flame" />
        <path id="stamp-circle" d="M 50,50 m -36,0 a 36,36 0 1,1 72,0 a 36,36 0 1,1 -72,0" fill="none" />
        <text className="fill-ink font-mono text-[8.5px] font-semibold uppercase tracking-[0.24em]">
          <textPath href="#stamp-circle">
            100% original · printed on demand · inkline ·
          </textPath>
        </text>
        <circle cx="50" cy="50" r="14" fill="none" className="stroke-ink" strokeWidth="1.5" />
        <text x="50" y="54" textAnchor="middle" className="fill-ink font-mono text-[11px] font-bold">
          ✳
        </text>
      </svg>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b-[1.5px] border-ink">
      {/* Giant ghost word behind everything */}
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-6 left-1/2 -translate-x-1/2 select-none whitespace-nowrap font-display text-[24vw] font-extrabold uppercase leading-none text-transparent opacity-[0.05]"
        style={{ WebkitTextStroke: "1.5px var(--color-ink)" }}
      >
        Inkline
      </span>

      <div className="mx-auto grid w-full max-w-[90rem] grid-cols-1 gap-10 px-5 pb-16 pt-12 sm:px-8 md:pt-20 lg:grid-cols-12 lg:gap-6 lg:px-12 lg:pb-24">
        {/* Copy */}
        <div className="relative z-10 flex flex-col justify-center lg:col-span-7">
          <motion.div variants={fadeUp} initial="hidden" animate="visible" custom={0}>
            <Badge variant="soft" className="gap-1.5">
              <Sparkles className="size-3 text-flame" aria-hidden />
              Print-on-demand studio · India
            </Badge>
          </motion.div>

          <motion.h1
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.12}
            className="mt-6 font-display text-[15vw] font-extrabold uppercase leading-[0.88] tracking-tight text-ink sm:text-7xl lg:text-8xl xl:text-[7.25rem]"
          >
            Wear your
            <br />
            <span
              className="text-transparent"
              style={{ WebkitTextStroke: "2px var(--color-ink)" }}
            >
              creativity
            </span>
            <span className="text-flame">.</span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.24}
            className="mt-6 max-w-xl text-base leading-relaxed text-smoke sm:text-lg"
          >
            Original artwork, printed fresh on premium tees, hoodies, mugs, posters and more —
            only after you order.{" "}
            <span className="font-semibold text-ink">No mass production. No waste.</span>{" "}
            Just your kind of original, made in India.
          </motion.p>

          <motion.div
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.36}
            className="mt-9 flex flex-wrap items-center gap-3"
          >
            <Button asChild size="lg" variant="primary">
              <Link href="/#shop">
                Shop the drop
                <ArrowRight className="size-4" aria-hidden />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/#how-it-works">
                How it works
                <ArrowDown className="size-4" aria-hidden />
              </Link>
            </Button>
          </motion.div>

          <motion.ul
            variants={fadeUp}
            initial="hidden"
            animate="visible"
            custom={0.48}
            className="mt-10 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[10px] uppercase tracking-[0.18em] text-smoke"
          >
            {["240 GSM heavyweight cotton", "Gallery-grade print inks", "Ships across India", "Zero inventory waste"].map(
              (item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <span className="text-flame" aria-hidden>✳</span>
                  {item}
                </li>
              ),
            )}
          </motion.ul>
        </div>

        {/* Artwork */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 24 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="relative z-10 lg:col-span-5"
        >
          <div className="relative mx-auto max-w-sm lg:max-w-none">
            <RotatingStamp />
            <div className="relative aspect-[4/5] overflow-hidden rounded-b-3xl rounded-t-[999px] border-[1.5px] border-ink bg-sand shadow-[10px_10px_0_0_var(--color-flame)]">
              <Image
                src="/images/hero.jpg"
                alt={`Model wearing an ${siteConfig.name} graphic tee from the first drop`}
                fill
                priority
                sizes="(max-width: 1024px) 90vw, 40vw"
                className="object-cover"
              />
            </div>
            <div className="absolute -right-3 bottom-8 rotate-3 rounded-2xl border-[1.5px] border-ink bg-paper px-4 py-3 shadow-[6px_6px_0_0_var(--color-ink)] sm:-right-6">
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-smoke">Drop 001</p>
              <p className="font-display text-sm font-bold uppercase">Fresh off the press</p>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
