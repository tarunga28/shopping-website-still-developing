import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyCart, EmptyState } from "@/components/ui/empty-state";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState title="Nothing here" description="Try something else" />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Try something else")).toBeInTheDocument();
  });

  it("renders an accessible CTA when provided", () => {
    render(<EmptyState title="Empty" action={{ label: "Shop now", href: "/shop" }} />);
    const link = screen.getByRole("link", { name: "Shop now" });
    expect(link).toHaveAttribute("href", "/shop");
  });

  it("empty cart preset explains itself", () => {
    render(<EmptyCart />);
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    expect(screen.getByText(/Continue shopping/i)).toBeInTheDocument();
  });
});
