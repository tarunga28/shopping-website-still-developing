import { Container } from "@/components/ui/container";
import { ProductGridSkeleton } from "@/components/ui/skeleton";

export default function StorefrontLoading() {
  return (
    <Container className="py-12">
      <div className="mb-8 h-10 w-48 animate-pulse rounded-xl bg-sand" />
      <ProductGridSkeleton count={8} />
    </Container>
  );
}
