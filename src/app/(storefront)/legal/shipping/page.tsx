import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { legalDocuments } from "@/config/legal-content";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: legalDocuments.shipping.title,
  description: legalDocuments.shipping.summary,
  path: "/legal/shipping",
});

export default function ShippingPage() {
  return <LegalPage doc={legalDocuments.shipping} />;
}
