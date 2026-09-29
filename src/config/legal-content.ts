/**
 * Pre-launch legal copy (template pending professional legal review).
 * Structured as data so all four policy pages share one layout
 * component and future edits happen in exactly one place.
 */

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalDocument {
  slug: string;
  title: string;
  summary: string;
  sections: LegalSection[];
}

export const legalDocuments: Record<string, LegalDocument> = {
  privacy: {
    slug: "privacy",
    title: "Privacy policy",
    summary: "What we collect, why we collect it, and the choices you have over your data.",
    sections: [
      {
        heading: "What we collect",
        paragraphs: [
          "When you join our newsletter we collect your email address so we can send launch announcements and product drops you've asked to hear about.",
          "When the store launches, we will additionally process the details needed to fulfil orders: your name, shipping address, contact details and order contents. Payment information is processed directly by our payment partners (Razorpay) and never touches our servers.",
        ],
      },
      {
        heading: "How we use it",
        paragraphs: [
          "We use your information only to operate the store: fulfilling orders, sending order and shipping updates, providing support, and — with your consent — sending marketing emails you can leave at any time.",
          "We do not sell, rent or trade your personal information to third parties for their own marketing.",
        ],
      },
      {
        heading: "Data security",
        paragraphs: [
          "Access to personal data is restricted to systems that need it to serve you, transport happens over encrypted connections, and operational secrets never leave server-side infrastructure.",
        ],
      },
      {
        heading: "Your choices",
        paragraphs: [
          "Every marketing email includes a one-click unsubscribe link. You may also request access to, correction of, or deletion of your personal data by writing to support@inkline.in.",
        ],
      },
    ],
  },
  terms: {
    slug: "terms",
    title: "Terms of service",
    summary: "The ground rules for using Inkline — purchases, artwork ownership and fair use.",
    sections: [
      {
        heading: "The service",
        paragraphs: [
          "Inkline sells original artwork printed on demand on apparel, drinkware, prints and accessories. Products are manufactured after an order is placed, which slightly extends delivery time compared to stocked retail.",
        ],
      },
      {
        heading: "Artwork ownership",
        paragraphs: [
          "All designs remain the property of their respective artists and Inkline. Purchasing a product grants you ownership of the physical item only — not the right to reproduce, resell or redistribute the artwork.",
        ],
      },
      {
        heading: "Pricing & availability",
        paragraphs: [
          "Prices are listed in Indian Rupees (INR) and include applicable taxes unless stated otherwise. Because every piece is made to order, we may occasionally pause or retire designs; affected orders are always refunded in full.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: [
          "You agree not to misuse the site, attempt to breach its security, scrape it at abusive volume, or use it for any unlawful purpose.",
        ],
      },
    ],
  },
  shipping: {
    slug: "shipping",
    title: "Shipping & delivery",
    summary: "How made-to-order production and delivery works across India.",
    sections: [
      {
        heading: "Production first",
        paragraphs: [
          "Every Inkline piece is printed after you order it. Production typically takes 2–4 business days before your order is handed to the courier.",
        ],
      },
      {
        heading: "Delivery timelines",
        paragraphs: [
          "Once shipped, delivery across metro India usually takes 2–4 business days, and 4–7 business days to other serviceable PIN codes. You receive tracking details by email/SMS as soon as your order ships.",
        ],
      },
      {
        heading: "Shipping charges",
        paragraphs: [
          "Shipping charges, free-shipping thresholds and serviceable PIN codes will be published at launch and shown clearly at checkout before you pay.",
        ],
      },
    ],
  },
  refunds: {
    slug: "refunds",
    title: "Returns & refunds",
    summary: "Our made-to-order fair policy — replacements for genuine issues, always.",
    sections: [
      {
        heading: "Made-to-order means",
        paragraphs: [
          "Because each piece is printed specifically for you, we cannot accept returns for change of mind or incorrect size selection. Size guides will be provided on every product page to help you choose confidently.",
        ],
      },
      {
        heading: "If something's wrong",
        paragraphs: [
          "If your order arrives damaged, misprinted or defective, we'll replace it or refund you in full. Contact support@inkline.in within 7 days of delivery with your order number and photos of the issue — no need to ship anything back in most cases.",
        ],
      },
      {
        heading: "Refund timelines",
        paragraphs: [
          "Approved refunds are processed to the original payment method within 5–7 business days through our payment partner, Razorpay.",
        ],
      },
    ],
  },
};
