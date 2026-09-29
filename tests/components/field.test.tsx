import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

describe("Field accessibility wiring", () => {
  it("associates label, description and error with the control", () => {
    render(
      <Field label="Email" description="We never share it." error="Invalid email" required>
        <Input type="email" />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: /email/i });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-required", "true");

    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    const description = document.getElementById(describedBy!.split(" ")[0]);
    expect(description).toHaveTextContent("We never share it.");

    expect(screen.getByRole("alert")).toHaveTextContent("Invalid email");
  });

  it("renders success messaging when valid", () => {
    render(
      <Field label="Email" success="Looks good">
        <Input type="email" />
      </Field>,
    );
    expect(screen.getByText("Looks good")).toBeInTheDocument();
  });
});
