import { expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_VIEW, Studio } from "../../src";
import { createMemoryLog, createMockDataSource, demoDataset } from "../../src/mock";

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));

test("→ under a posts row shows the author; Open filters users to that id", async () => {
  const ds = createMockDataSource({ dataset: demoDataset(1), log: createMemoryLog() });
  const views: string[] = [];
  render(
    <Studio
      dataSource={ds}
      codeEditor="textarea"
      defaultView={{ ...EMPTY_VIEW, table: "public.posts" }}
      onViewChange={(v) => views.push(v.table ?? "")}
    />,
  );
  await screen.findByText("Post 1");
  const row = screen.getByText("Post 1").closest("[role=row]") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /users/i }));
  await settle();
  const preview = screen.getByRole("region", { name: "Related users" });
  expect(preview.textContent).toMatch(/user\d+@example\.com/);
  const post1 = screen.getByText("Post 1").closest("[role=row]") as HTMLElement;
  const post2 = screen.getByText("Post 2").closest("[role=row]") as HTMLElement;
  const r1 = post1.getBoundingClientRect();
  const r2 = post2.getBoundingClientRect();
  // happy-dom paints every element with the same box; a rect overlap expect would be vacuous or false.
  if (r1.height > 0 && r1.bottom !== r2.bottom) {
    expect(r2.top).toBeGreaterThan(r1.bottom);
  } else {
    expect(post1.contains(preview)).toBe(true);
    expect(post1.style.height).not.toBe("32px");
    expect(post1.childElementCount).toBeGreaterThan(1);
  }
  fireEvent.click(within(preview).getByRole("button", { name: "Open" }));
  expect(views.at(-1)).toBe("public.users");
  await settle();
  await screen.findByText(/1 - 1 of 1/);
  expect(screen.getByText("user1@example.com").textContent).toMatch(/@example\.com/);
});
