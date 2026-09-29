import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Price } from "@/components/ui/price";

describe("Price", () => {
  it("renders the formatted INR amount", () => {
    render(<Price amount={89900} />);
    expect(screen.getByText("₹899")).toBeInTheDocument();
  });

  it("shows the struck-through compare-at price on sale", () => {
    const { container } = render(<Price amount={79900} compareAt={99900} />);
    expect(screen.getByText("₹799")).toBeInTheDocument();
    const struck = container.querySelector("s");
    expect(struck).toHaveTextContent("₹999");
    expect(screen.getByText("on sale")).toBeInTheDocument();
  });

  it("does not render a compare-at strike when not discounted", () => {
    const { container } = render(<Price amount={49900} compareAt={49900} />);
    expect(container.querySelector("s")).toBeNull();
  });
});
