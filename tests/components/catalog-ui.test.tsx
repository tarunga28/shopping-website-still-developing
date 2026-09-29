import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

import { ActiveFilters } from "@/components/catalog/active-filters";
import { CatalogEmpty } from "@/components/catalog/catalog-empty";
import { CatalogNavProvider } from "@/components/catalog/catalog-nav";
import { CatalogPagination } from "@/components/catalog/catalog-pagination";
import { FilterSidebar } from "@/components/catalog/filter-panel";
import { SortSelect } from "@/components/catalog/sort-select";
import { EMPTY_FILTERS, type CatalogFilters } from "@/lib/catalog/params";
import { buildPaginationMeta } from "@/lib/catalog/pagination";
import type { FacetView } from "@/lib/catalog/facets-view";

const filters = (patch: Partial<CatalogFilters> = {}): CatalogFilters => ({ ...EMPTY_FILTERS, ...patch });

describe("CatalogPagination", () => {
  const meta = (page: number, total = 240) => buildPaginationMeta({ page, pageSize: 24, total, count: 24 });

  it("renders nothing for a single page", () => {
    const { container } = render(<CatalogPagination basePath="/shop" filters={filters()} pagination={meta(1, 10)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("disables Prev on the first page and Next on the last, without dead links", () => {
    const { unmount } = render(<CatalogPagination basePath="/shop" filters={filters()} pagination={meta(1)} />);
    const prev = screen.getByLabelText("Go to previous page");
    expect(prev.tagName).toBe("SPAN");
    expect(prev).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Go to next page")).toHaveAttribute("href", "/shop?page=2");
    unmount();

    render(<CatalogPagination basePath="/shop" filters={filters({ page: 10 })} pagination={meta(10)} />);
    expect(screen.getByLabelText("Go to next page")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Go to previous page")).toHaveAttribute("href", "/shop?page=9");
  });

  it("keeps filters and sort in every page link and uses the clean URL for page 1", () => {
    render(<CatalogPagination basePath="/category/hoodies" filters={filters({ page: 2, sort: "price-asc", sizes: ["M"] })} pagination={meta(2)} />);
    expect(screen.getByLabelText("Go to previous page")).toHaveAttribute("href", "/category/hoodies?size=M&sort=price-asc");
    expect(screen.getByLabelText("Go to page 3")).toHaveAttribute("href", "/category/hoodies?size=M&sort=price-asc&page=3");
  });

  it("marks the current page and shows the mobile 'Page X of Y' summary", () => {
    render(<CatalogPagination basePath="/shop" filters={filters({ page: 5 })} pagination={meta(5)} />);
    expect(screen.getByLabelText("Page 5, current page")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Page 5 of 10")).toBeInTheDocument();
    expect(screen.getByLabelText("Go to next page")).toHaveAttribute("rel", "next");
  });
});

describe("ActiveFilters", () => {
  it("renders nothing when no filter is applied", () => {
    const { container } = render(<ActiveFilters basePath="/shop" filters={filters({ sort: "newest" })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a removal link per filter and a Clear all that keeps the sort", () => {
    render(<ActiveFilters basePath="/shop" filters={filters({ sort: "newest", type: "HOODIE", sizes: ["M", "L"], minPricePaise: 50_000, maxPricePaise: 199_950 })} />);
    expect(screen.getByLabelText("Remove filter: Size M")).toHaveAttribute("href", "/shop?type=hoodie&size=L&minPrice=500&maxPrice=1999.50&sort=newest");
    expect(screen.getByLabelText("Remove filter: ₹500 – ₹1999.50")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear all" })).toHaveAttribute("href", "/shop?sort=newest");
  });
});

describe("CatalogEmpty", () => {
  it("shows the four required empty states", () => {
    const { rerender } = render(<CatalogEmpty scope={{ kind: "shop" }} scopeIsEmpty clearHref="/shop" />);
    expect(screen.getByText("Our store is getting ready.")).toBeInTheDocument();
    expect(screen.getByText("New designs are coming soon.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return Home" })).toHaveAttribute("href", "/");

    rerender(<CatalogEmpty scope={{ kind: "category", slug: "x" }} scopeIsEmpty clearHref="/category/x" />);
    expect(screen.getByText("No products available in this category yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse All Products" })).toHaveAttribute("href", "/shop");

    rerender(<CatalogEmpty scope={{ kind: "collection", slug: "x" }} scopeIsEmpty clearHref="/collection/x" />);
    expect(screen.getByText("No products in this collection yet.")).toBeInTheDocument();

    rerender(<CatalogEmpty scope={{ kind: "shop" }} scopeIsEmpty={false} clearHref="/shop?sort=newest" />);
    expect(screen.getByText("No products match your selected filters.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear Filters" })).toHaveAttribute("href", "/shop?sort=newest");
  });
});

const facets: FacetView = {
  types: [
    { value: "t-shirt", label: "T-Shirts", count: 2 },
    { value: "hoodie", label: "Hoodies", count: 1 },
  ],
  sizes: [
    { value: "M", label: "M", count: 2 },
    { value: "L", label: "L", count: 1 },
  ],
  colors: [{ value: "black", label: "Black", count: 2, swatch: "#000000" }, { value: "red", label: "Red", count: 1 }],
  price: { minLabel: "300", maxLabel: "900" },
  availability: true,
};

describe("filter sidebar", () => {
  beforeEach(() => push.mockReset());

  const renderSidebar = (current: CatalogFilters = filters()) =>
    render(
      <CatalogNavProvider>
        <FilterSidebar basePath="/shop" filters={current} facets={facets} />
      </CatalogNavProvider>,
    );

  it("groups controls in labelled fieldsets", () => {
    renderSidebar();
    for (const name of ["Product type", "Price (₹)", "Size", "Color", "Availability"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument();
    }
  });

  it("puts a size selection in the URL immediately", () => {
    renderSidebar(filters({ sort: "newest" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^M/ }));
    expect(push).toHaveBeenCalledWith("/shop?size=M&sort=newest", { scroll: false });
  });

  it("supports multiple values and removal", () => {
    renderSidebar(filters({ sizes: ["M"] }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^L/ }));
    expect(push).toHaveBeenLastCalledWith("/shop?size=M,L", { scroll: false });
  });

  it("resets to page 1 when a filter changes", () => {
    renderSidebar(filters({ page: 3 }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Available to order/ }));
    expect(push).toHaveBeenCalledWith("/shop?availability=available", { scroll: false });
  });

  it("does not navigate on an invalid price and explains why", () => {
    renderSidebar();
    const min = screen.getByLabelText("Minimum price in rupees");
    fireEvent.change(min, { target: { value: "hello" } });
    fireEvent.blur(min);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a price");
  });

  it("applies a valid price range on blur", () => {
    renderSidebar();
    const min = screen.getByLabelText("Minimum price in rupees");
    fireEvent.change(min, { target: { value: "500" } });
    fireEvent.blur(min);
    expect(push).toHaveBeenCalledWith("/shop?minPrice=500", { scroll: false });
  });

  it("offers Clear all only when filters are applied", () => {
    const { unmount } = renderSidebar();
    expect(screen.queryByRole("link", { name: "Clear all" })).not.toBeInTheDocument();
    unmount();
    renderSidebar(filters({ colors: ["red"] }));
    expect(screen.getByRole("link", { name: "Clear all" })).toHaveAttribute("href", "/shop");
  });
});

describe("SortSelect", () => {
  it("lists only the supported sorts and navigates through the URL", () => {
    push.mockReset();
    render(
      <CatalogNavProvider>
        <SortSelect basePath="/shop" filters={filters({ sizes: ["M"], page: 4 })} />
      </CatalogNavProvider>,
    );
    const select = screen.getByRole("combobox");
    const options = within(select).getAllByRole("option").map((option) => option.getAttribute("value"));
    expect(options).toEqual(["featured", "newest", "price-asc", "price-desc", "name"]);
    fireEvent.change(select, { target: { value: "price-asc" } });
    expect(push).toHaveBeenCalledWith("/shop?size=M&sort=price-asc", { scroll: false });
  });
});
