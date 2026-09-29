import type { HowItWorksStep, ProductCategory, ProductSummary, Testimonial } from "@/types";

/**
 * SAMPLE DISPLAY DATA — foundation milestone only.
 *
 * Homepage sections are built as data-driven, reusable components.
 * Until the catalog database ships, they render this sample data so the
 * design system is exercised end-to-end. Nothing here is cart-connected
 * or purchasable; later milestones swap this module for DB queries with
 * zero changes to the section components themselves.
 */

export const sampleCategories: ProductCategory[] = [
  {
    slug: "t-shirts",
    name: "T-Shirts",
    description: "Heavyweight 240 GSM cotton, unisex fits.",
    image: "/images/products/tee.jpg",
    fromPricePaise: 89900,
  },
  {
    slug: "hoodies",
    name: "Hoodies",
    description: "Brushed fleece, kangaroo pocket, drop shoulders.",
    image: "/images/products/hoodie.jpg",
    fromPricePaise: 199900,
  },
  {
    slug: "sweatshirts",
    name: "Sweatshirts",
    description: "Cozy crewnecks for everyday layering.",
    image: "/images/products/sweatshirt.jpg",
    fromPricePaise: 149900,
  },
  {
    slug: "mugs",
    name: "Mugs",
    description: "Ceramic, dishwasher-safe, 325 ml.",
    image: "/images/products/mug.jpg",
    fromPricePaise: 49900,
  },
  {
    slug: "posters",
    name: "Posters",
    description: "Museum-grade matte paper, gallery inks.",
    image: "/images/products/poster.jpg",
    fromPricePaise: 34900,
  },
  {
    slug: "tote-bags",
    name: "Tote Bags",
    description: "Sturdy 12 oz canvas with long handles.",
    image: "/images/products/tote.jpg",
    fromPricePaise: 69900,
  },
  {
    slug: "phone-cases",
    name: "Phone Cases",
    description: "Slim, impact-resistant, matte finish.",
    image: "/images/products/phone-case.jpg",
    fromPricePaise: 79900,
  },
];

export const sampleProducts: ProductSummary[] = [
  {
    id: "sample-01",
    slug: "offbeat-grid-tee",
    title: "Offbeat Grid Tee",
    category: "T-Shirts",
    pricePaise: 89900,
    compareAtPaise: 119900,
    image: "/images/products/tee.jpg",
    hoverImage: "/images/hero.jpg",
    badge: "NEW",
    rating: { value: 4.8, count: 24 },
    availability: "in_stock",
    blurb: "240 GSM heavyweight cotton with the signature swirling grid print.",
  },
  {
    id: "sample-02",
    slug: "ember-sketch-hoodie",
    title: "Ember Sketch Hoodie",
    category: "Hoodies",
    pricePaise: 199900,
    image: "/images/products/hoodie.jpg",
    hoverImage: "/images/products/sweatshirt.jpg",
    badge: "BESTSELLER",
    rating: { value: 4.9, count: 41 },
    availability: "in_stock",
    blurb: "Brushed fleece hoodie with hand-drawn ember line art.",
  },
  {
    id: "sample-03",
    slug: "studio-sweatshirt",
    title: "Studio Sweatshirt",
    category: "Sweatshirts",
    pricePaise: 149900,
    image: "/images/products/sweatshirt.jpg",
    hoverImage: "/images/products/hoodie.jpg",
    rating: { value: 4.6, count: 17 },
    availability: "in_stock",
    blurb: "Cozy crewneck for studio days and slow Sundays.",
  },
  {
    id: "sample-04",
    slug: "morning-ritual-mug",
    title: "Morning Ritual Mug",
    category: "Mugs",
    pricePaise: 49900,
    image: "/images/products/mug.jpg",
    badge: "NEW",
    rating: { value: 4.7, count: 33 },
    availability: "in_stock",
    blurb: "Dishwasher-safe ceramic with wrap-around line art.",
  },
  {
    id: "sample-05",
    slug: "sunset-lines-poster",
    title: "Sunset Lines Poster",
    category: "Posters",
    pricePaise: 34900,
    image: "/images/products/poster.jpg",
    rating: { value: 4.9, count: 58 },
    availability: "in_stock",
    blurb: "Museum-grade matte print with gallery inks.",
  },
  {
    id: "sample-06",
    slug: "carry-chaos-tote",
    title: "Carry Chaos Tote",
    category: "Tote Bags",
    pricePaise: 69900,
    image: "/images/products/tote.jpg",
    badge: "LOW_STOCK",
    rating: { value: 4.5, count: 12 },
    availability: "low_stock",
    blurb: "12 oz canvas tote that carries it all — beautifully.",
  },
  {
    id: "sample-07",
    slug: "pocket-art-case",
    title: "Pocket Art Case",
    category: "Phone Cases",
    pricePaise: 79900,
    image: "/images/products/phone-case.jpg",
    rating: { value: 4.4, count: 9 },
    availability: "in_stock",
    blurb: "Slim impact-resistant case with matte art finish.",
  },
  {
    id: "sample-08",
    slug: "ink-marker-tee",
    title: "Ink Marker Tee",
    category: "T-Shirts",
    pricePaise: 99900,
    image: "/images/products/tee.jpg",
    hoverImage: "/images/hero.jpg",
    badge: "BESTSELLER",
    rating: { value: 4.8, count: 36 },
    availability: "in_stock",
    blurb: "Marker-line portrait print on heavyweight ecru cotton.",
  },
];

/** Sample collections shown in the header Collections dropdown (UI preview). */
export const sampleCollections = [
  { slug: "wave-study", name: "Wave Study", description: "Fluid line art from the coast residency." },
  { slug: "grid-and-grain", name: "Grid & Grain", description: "Geometry meets hand texture." },
  { slug: "ink-portraits", name: "Ink Portraits", description: "Faces drawn in a single sitting." },
  { slug: "studio-notes", name: "Studio Notes", description: "Sketches from the print floor." },
] as const;

export const howItWorksSteps: HowItWorksStep[] = [
  {
    step: "01",
    title: "Choose a design",
    description:
      "Browse original artwork from independent artists, printed on premium tees, hoodies, mugs, posters and more.",
  },
  {
    step: "02",
    title: "Place your order",
    description:
      "Checkout securely with UPI, cards or netbanking. You pay only for what you love — nothing more.",
  },
  {
    step: "03",
    title: "We print it fresh",
    description:
      "Nothing sits in a warehouse. Your piece is printed, cured and quality-checked only after you order it.",
  },
  {
    step: "04",
    title: "We ship it to you",
    description:
      "Packed with care and shipped across India with live tracking — from our print floor to your doorstep.",
  },
];

export const sampleTestimonials: Testimonial[] = [
  {
    id: "t-01",
    quote:
      "The print quality genuinely surprised me — colours are punchy and the tee feels heavy in the best way. Three washes in, still perfect.",
    name: "Aarav M.",
    location: "Bengaluru",
    rating: 5,
    productLabel: "Offbeat Grid Tee",
  },
  {
    id: "t-02",
    quote:
      "Ordered a hoodie for my sister and a mug for myself. Packaging was plastic-free and the tracking updates were spot on.",
    name: "Priya S.",
    location: "Pune",
    rating: 5,
    productLabel: "Ember Sketch Hoodie",
  },
  {
    id: "t-03",
    quote:
      "Posters look like gallery prints. You can tell each piece is made when ordered instead of pulled off a shelf.",
    name: "Rohan K.",
    location: "New Delhi",
    rating: 5,
    productLabel: "Sunset Lines Poster",
  },
];
