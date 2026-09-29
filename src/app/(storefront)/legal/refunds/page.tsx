import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { legalDocuments } from "@/config/legal-content";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: legalDocuments.refunds.title,
  description: legalDocuments.refunds.summary,
  path: "/legal/refunds",
});

export default function RefundsPage() {
  return <LegalPage doc={legalDocuments.refunds} />;
}
