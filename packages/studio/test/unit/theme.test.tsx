import { expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "../../src/studio/theme";

test("the toggle cycles system → light → dark, applies the class and remembers it", () => {
  const first = render(<ThemeToggle />);
  const button = () => screen.getByRole("button", { name: /^Theme:/ });
  expect(button().getAttribute("aria-label")).toBe("Theme: system");
  fireEvent.click(button());
  expect(button().getAttribute("aria-label")).toBe("Theme: light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  fireEvent.click(button());
  expect(button().getAttribute("aria-label")).toBe("Theme: dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  first.unmount();
  document.documentElement.className = "";

  render(<ThemeToggle />);
  expect(button().getAttribute("aria-label")).toBe("Theme: dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});
