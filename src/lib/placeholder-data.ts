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
    description: "Poster sample. Development sample, not a live listing.",
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
    description: "Phone case sample. Development sample, not a live listing.",
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
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
    rating: { value: 0, count: 0 },
    availability: "in_stock",
    blurb: "Tee sample. Development sample, not a live listing.",
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
    description: "Browse artwork that is already in the catalogue.",
  },
  {
    step: "02",
    title: "Save what you like",
    description: "Accounts and wishlists are live. Checkout is not open yet.",
  },
  {
    step: "03",
    title: "We print after the order",
    description: "That is the production model. A print partner is not connected yet.",
  },
  {
    step: "04",
    title: "Shipping comes later",
    description: "Delivery tracking is not live. Nothing is promised as in transit.",
  },
];

/** Unused by the storefront. Kept empty so fabricated quotes cannot be rendered. */
export const sampleTestimonials: Testimonial[] = [];
