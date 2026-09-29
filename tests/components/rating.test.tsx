import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Rating } from "@/components/ui/rating";

describe("Rating", () => {
  it("exposes an accessible label with value and count", () => {
    render(<Rating value={4.5} count={128} />);
    expect(screen.getByRole("img", { name: /Rated 4.5 out of 5 from 128 reviews/i })).toBeInTheDocument();
  });

  it("shows the numeric value (not color-only)", () => {
    render(<Rating value={3.5} />);
    expect(screen.getByText("3.5")).toBeInTheDocument();
  });
});
