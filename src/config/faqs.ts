/** Frequently asked questions — content as data, rendered on /faqs. */

export interface Faq {
  question: string;
  answer: string;
}

export const faqGroups: { title: string; faqs: Faq[] }[] = [
  {
    title: "Ordering & production",
    faqs: [
      {
        question: "When do you print my order?",
        answer:
          "Only after you place it. Every Inkline piece is printed on demand — production starts once your order is confirmed, typically taking 2–4 business days before dispatch.",
      },
      {
        question: "Do you keep stock?",
        answer:
          "No. Print-on-demand means zero warehouse inventory: nothing is mass-produced, nothing is sitting on shelves, and nothing goes to a landfill because it didn't sell.",
      },
      {
        question: "Can I change or cancel my order?",
        answer:
          "If production hasn't started yet, yes — email support@inkline.in within 12 hours of ordering with your order number and we'll do our best.",
      },
    ],
  },
  {
    title: "Shipping & delivery",
    faqs: [
      {
        question: "How long does delivery take?",
        answer:
          "Production (2–4 business days) plus courier transit: usually 2–4 business days to metro India and 4–7 business days to other serviceable PIN codes.",
      },
      {
        question: "Do you ship outside India?",
        answer:
          "We're launching India-first. International shipping is on the roadmap — join the newsletter to hear when it opens.",
      },
      {
        question: "How do I track my order?",
        answer:
          "Once your piece ships, you'll receive tracking details by email and SMS. A live order-tracking page ships with customer accounts.",
      },
    ],
  },
  {
    title: "Print & product quality",
    faqs: [
      {
        question: "What materials do you print on?",
        answer:
          "Heavyweight 240 GSM cotton tees, brushed-fleece hoodies and sweatshirts, dishwasher-safe ceramic mugs, museum-grade matte poster stock, 12 oz canvas totes and impact-resistant phone cases.",
      },
      {
        question: "Will the print crack or fade?",
        answer:
          "We use gallery-grade inks and proper curing, so prints stay vibrant with normal care. Wash inside-out in cold water and avoid ironing directly over the artwork.",
      },
      {
        question: "What if my order arrives damaged or misprinted?",
        answer:
          "We replace or refund it — email support@inkline.in within 7 days of delivery with photos. No need to ship anything back in most cases. Full details live in our refund policy.",
      },
    ],
  },
  {
    title: "Payments & security",
    faqs: [
      {
        question: "Which payment methods will you accept?",
        answer:
          "UPI, credit and debit cards (Visa, Mastercard, RuPay) and netbanking — processed securely by Razorpay at launch. Card details never touch our servers.",
      },
      {
        question: "Is my data safe?",
        answer:
          "We collect the minimum needed to run the store, transport it over encrypted connections, and never sell it. See the privacy policy for the full picture.",
      },
    ],
  },
];
