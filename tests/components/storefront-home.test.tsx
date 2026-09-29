/* eslint-disable @next/next/no-img-element -- test double for next/image */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Categories } from "@/components/home/categories";
import { FeaturedProducts } from "@/components/home/featured-products";
import { Reviews } from "@/components/home/reviews";
import { sampleTestimonials } from "@/lib/placeholder-data";
import type { ProductSummary } from "@/types";
import type { HomepageModel } from "@/services/storefront.service";
import type { StorefrontCategory, StorefrontReview } from "@/types/storefront";

vi.mock("next/image", () => ({
  default: function MockImage({ alt, src }: { alt: string; src: string }) {
    return <img alt={alt} src={src} />;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("@/services/storefront.service", () => ({
  loadHomepage: vi.fn(),
}));

vi.mock("@/server/actions/account-actions", () => ({
  toggleWishlistAction: vi.fn(),
}));

const product: ProductSummary = {
  id: "prod_1",
  slug: "offbeat-grid-tee",
  title: "Offbeat Grid Tee",
  category: "T-Shirts",
  categorySlug: "t-shirts",
  pricePaise: 89900,
  compareAtPaise: 119900,
  image: "/images/products/tee.jpg",
  imageAlt: "Folded tee with an abstract line-grid print",
  hoverImage: "/images/hero.jpg",
  badge: "NEW",
  rating: { value: 0, count: 0 },
  availability: "in_stock",
};

const category: StorefrontCategory = {
  slug: "t-shirts",
  name: "T-Shirts",
  description: "Tees printed after you order.",
  image: "/images/products/tee.jpg",
  imageAlt: "Folded tee with an abstract line-grid print",
  fromPricePaise: 89900,
  productCount: 2,
};

const review: StorefrontReview = {
  id: "rev_1",
  rating: 5,
  title: "Held up",
  quote: "The print is still crisp.",
  authorName: "Real Buyer",
  productLabel: "Offbeat Grid Tee",
  productHref: "/product/offbeat-grid-tee",
  verifiedPurchase: true,
  image: null,
  imageAlt: null,
};

function homepage(overrides: Partial<HomepageModel> = {}): HomepageModel {
  return {
    products: { data: [product], status: "ok" },
    categories: { data: [category], status: "ok" },
    featuredProducts: { data: [product], status: "ok" },
    newArrivals: { data: [product], status: "ok" },
    featuredCollection: { data: null, status: "empty" },
    reviews: { data: [], status: "empty" },
    savedIds: [],
    ...overrides,
  };
}

describe("homepage sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the required sections, one H1, and no fabricated reviews", async () => {
    const { loadHomepage } = await import("@/services/storefront.service");
    vi.mocked(loadHomepage).mockResolvedValue(homepage());
    const { default: HomePage } = await import("@/app/(storefront)/page");

    render(await HomePage());

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: /original art/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /shop the collection/i })).toHaveAttribute("href", "/shop");
    expect(screen.getByRole("link", { name: /explore designs/i })).toHaveAttribute("href", "/#designs");
    expect(document.getElementById("categories")).toBeInTheDocument();
    expect(document.getElementById("shop")).toBeInTheDocument();
    expect(document.getElementById("new-arrivals")).toBeInTheDocument();
    expect(document.getElementById("how-it-works")).toBeInTheDocument();
    expect(document.getElementById("why-us")).toBeInTheDocument();
    expect(document.getElementById("designs")).toBeInTheDocument();
    expect(document.getElementById("reviews")).toBeInTheDocument();
    expect(document.getElementById("newsletter")).toBeInTheDocument();
    expect(screen.getByText(/your review could be here/i)).toBeInTheDocument();
    expect(screen.queryByText(/aarav/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/guaranteed delivery/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/eco-friendly/i)).not.toBeInTheDocument();
    expect(sampleTestimonials).toEqual([]);

    const headings = [...document.querySelectorAll("h1, h2, h3, h4")].map((node) => Number(node.tagName.slice(1)));
    let floor = 1;
    for (const level of headings) {
      expect(level).toBeLessThanOrEqual(floor + 1);
      floor = Math.max(floor, level);
    }
  });

  it("keeps the rest of the page when one section fails", async () => {
    const { loadHomepage } = await import("@/services/storefront.service");
    vi.mocked(loadHomepage).mockResolvedValue(
      homepage({
        categories: { data: [], status: "error" },
        featuredProducts: { data: [], status: "ok" },
      }),
    );
    const { default: HomePage } = await import("@/app/(storefront)/page");

    render(await HomePage());

    expect(screen.getByText(/categories didn't load/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(document.getElementById("newsletter")).toBeInTheDocument();
    expect(screen.getByText(/no products found/i)).toBeInTheDocument();
  });

  it("shows empty catalogue states instead of sample products", () => {
    render(
      <>
        <Categories categories={[]} status="empty" />
        <FeaturedProducts products={[]} status="empty" />
        <Reviews reviews={[]} status="empty" />
      </>,
    );

    expect(screen.getByText(/no categories published/i)).toBeInTheDocument();
    expect(screen.getByText(/no products found/i)).toBeInTheDocument();
    expect(screen.getByText(/your review could be here/i)).toBeInTheDocument();
    expect(screen.queryByText(/offbeat grid tee/i)).not.toBeInTheDocument();
  });

  it("renders a real review only when one is supplied", () => {
    render(<Reviews reviews={[review]} status="ok" />);
    expect(screen.getByText(/the print is still crisp/i)).toBeInTheDocument();
    expect(screen.getByText("Real Buyer")).toBeInTheDocument();
  });

  it("uses one keyboard-accessible product card with alt text and slug links", () => {
    render(<FeaturedProducts products={[product]} status="ok" />);
    const card = screen.getByRole("link", { name: product.imageAlt }).closest("li");
    expect(card).not.toBeNull();
    const scope = within(card as HTMLElement);
    const imageLink = scope.getByRole("link", { name: product.imageAlt });
    expect(imageLink).toHaveAttribute("href", "/product/offbeat-grid-tee");
    expect(imageLink.querySelector("img")).toHaveAttribute("alt", product.imageAlt);
    expect(scope.getByRole("link", { name: product.title })).toHaveAttribute("href", "/product/offbeat-grid-tee");
    expect(scope.getByRole("button", { name: /add offbeat grid tee to wishlist/i })).toBeInTheDocument();
    expect(scope.getByRole("button", { name: /quick view offbeat grid tee/i })).toBeInTheDocument();
    expect(screen.queryByText(/prod_1/)).not.toBeInTheDocument();
  });

  it("makes a category card one link, not a hardcoded route table", () => {
    render(<Categories categories={[category]} status="ok" />);
    const link = screen.getByRole("link", { name: /t-shirts/i });
    expect(link).toHaveAttribute("href", "/category/t-shirts");
    expect(link.querySelector("img")).toHaveAttribute("alt", category.imageAlt);
    expect(link.className).toContain("focus-visible:outline");
  });
});
