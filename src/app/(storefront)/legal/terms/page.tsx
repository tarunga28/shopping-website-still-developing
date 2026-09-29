import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { legalDocuments } from "@/config/legal-content";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: legalDocuments.terms.title,
  description: legalDocuments.terms.summary,
  path: "/legal/terms",
});

export default function TermsPage() {
  return <LegalPage doc={legalDocuments.terms} />;
}
