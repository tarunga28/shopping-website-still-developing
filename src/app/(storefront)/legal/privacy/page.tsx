import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { legalDocuments } from "@/config/legal-content";
import { buildMetadata } from "@/lib/seo";

export const metadata: Metadata = buildMetadata({
  title: legalDocuments.privacy.title,
  description: legalDocuments.privacy.summary,
  path: "/legal/privacy",
});

export default function PrivacyPage() {
  return <LegalPage doc={legalDocuments.privacy} />;
}
