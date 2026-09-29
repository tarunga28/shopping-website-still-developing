import { act, fireEvent } from "@testing-library/react";

/**
 * Minimal stand-in for @testing-library/user-event (not a project dependency).
 * Covers what the storefront tests need: click, clear, type into a field, and
 * a single key press delivered to the focused element.
 */
export const userEvent = {
  setup() {
    return {
      async click(element: Element) {
        await act(async () => {
          if (element instanceof HTMLElement) element.focus();
          fireEvent.click(element);
        });
      },
      async clear(element: Element) {
        await act(async () => {
          fireEvent.change(element, { target: { value: "" } });
        });
      },
      async type(element: Element, text: string) {
        await act(async () => {
          fireEvent.change(element, { target: { value: text } });
        });
      },
      async keyboard(sequence: string) {
        const key = sequence.replace(/[{}]/g, "");
        await act(async () => {
          fireEvent.keyDown(document.activeElement ?? document.body, { key });
        });
      },
    };
  },
};
