# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: two-tabs.e2e.ts >> writes from two tabs at once converge: every open page ends with all of them
- Location: e2e/two-tabs.e2e.ts:74:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 20
Received: 10

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]: Mock
    - generic [ref=e6]: latency 0 ms
    - button "External write" [ref=e7]
    - button "Reset data" [ref=e8]
  - generic [ref=e10]:
    - navigation "Tables" [ref=e11]:
      - combobox "Schema" [ref=e12]:
        - generic [ref=e13]: public
        - img [aria-hidden]: ▼
      - textbox [aria-hidden] [ref=e14]: public
      - searchbox "Search tables" [ref=e15]
      - list [ref=e16]:
        - listitem [ref=e17]:
          - button "audit_log" [ref=e18]:
            - generic [ref=e22]: "50"
        - listitem [ref=e23]:
          - button "comments" [ref=e24]:
            - generic [ref=e28]: 2.00K
        - listitem [ref=e29]:
          - button "posts" [ref=e30]:
            - generic [ref=e34]: 1.50K
        - listitem [ref=e35]:
          - button "users" [ref=e36]:
            - generic [ref=e40]: 3.00K
        - listitem [ref=e41]:
          - button "published_posts" [ref=e42]
    - main [ref=e49]:
      - generic [ref=e50]:
        - generic [ref=e51]: No table selected
        - 'button "Theme: system" [ref=e53]'
      - paragraph [ref=e55]: Pick a table on the left.
```

# Test source

```ts
  10  |   await tab.getByRole("button", { name: "users", exact: true }).click();
  11  |   await expect(tab.getByRole("gridcell", { name: "user1@example.com", exact: true })).toBeVisible();
  12  | }
  13  | 
  14  | /** The id of user1, read through the data source like any client would. */
  15  | function user1Id(tab: Tab) {
  16  |   return tab.evaluate(async (users) => {
  17  |     const ds = window.__dzbMock;
  18  |     if (!ds) throw new Error("the playground did not expose __dzbMock");
  19  |     const page = await new Promise<Page>((resolve, reject) => {
  20  |       const stop = ds.subscribePage(
  21  |         { table: users, filters: [{ column: "email", op: "eq", value: "user1@example.com" }], sort: [], limit: 1, offset: 0 },
  22  |         (p) => {
  23  |           stop();
  24  |           resolve(p);
  25  |         },
  26  |         reject,
  27  |       );
  28  |     });
  29  |     // users.id is a uuid: text on the wire.
  30  |     return String(page.rows[0]?.["id"]);
  31  |   }, USERS);
  32  | }
  33  | 
  34  | test("an external write appears in every open tab without a refresh", async ({ context }) => {
  35  |   const a = await context.newPage();
  36  |   const b = await context.newPage();
  37  |   const psql = await context.newPage();
  38  |   await openUsers(a);
  39  |   await openUsers(b);
  40  |   await psql.goto("/");
  41  |   const id = await user1Id(psql);
  42  |   await psql.evaluate(
  43  |     async ({ users, id }) => {
  44  |       await window.__dzbMock?.externalWrite({
  45  |         kind: "update",
  46  |         table: users,
  47  |         changes: [{ key: { id }, values: { name: "Set by psql" } }],
  48  |       });
  49  |     },
  50  |     { users: USERS, id },
  51  |   );
  52  |   for (const tab of [a, b]) {
  53  |     const cell = tab.getByRole("gridcell", { name: "Set by psql", exact: true });
  54  |     await expect(cell).toBeVisible();
  55  |     await expect(cell).toHaveAttribute("data-changed", "true");
  56  |   }
  57  | });
  58  | 
  59  | test("a write in one tab appears in the other", async ({ context }) => {
  60  |   const a = await context.newPage();
  61  |   const b = await context.newPage();
  62  |   await openUsers(a);
  63  |   await openUsers(b);
  64  |   const id = await user1Id(a);
  65  |   await a.evaluate(
  66  |     async ({ users, id }) => {
  67  |       await window.__dzbMock?.updateRows(users, [{ key: { id }, values: { name: "Set in tab A" } }]);
  68  |     },
  69  |     { users: USERS, id },
  70  |   );
  71  |   await expect(b.getByRole("gridcell", { name: "Set in tab A", exact: true })).toBeVisible();
  72  | });
  73  | 
  74  | test("writes from two tabs at once converge: every open page ends with all of them", async ({ context }) => {
  75  |   const a = await context.newPage();
  76  |   const b = await context.newPage();
  77  |   await a.goto("/");
  78  |   await b.goto("/");
  79  |   // Each tab keeps a live subscription open from before the writes; only pushes can bring the other tab's rows.
  80  |   const watch = (tab: Tab) =>
  81  |     tab.evaluate(() => {
  82  |       const ds = window.__dzbMock;
  83  |       if (!ds) throw new Error("no __dzbMock");
  84  |       const w = window as unknown as { __ids?: unknown[] };
  85  |       ds.subscribePage(
  86  |         {
  87  |           table: { schema: "billing", name: "invoices" },
  88  |           filters: [{ column: "status", op: "like", value: "concurrent-%" }],
  89  |           sort: [],
  90  |           limit: 100,
  91  |           offset: 0,
  92  |         },
  93  |         (p) => {
  94  |           w.__ids = p.rows.map((r) => r["id"]);
  95  |         },
  96  |         () => {},
  97  |       );
  98  |     });
  99  |   await watch(a);
  100 |   await watch(b);
  101 |   const insertTen = (tab: Tab, who: string) =>
  102 |     tab.evaluate(async (who) => {
  103 |       const invoices = { schema: "billing", name: "invoices" };
  104 |       for (let i = 0; i < 10; i++) {
  105 |         await window.__dzbMock?.insertRows(invoices, [{ amount_cents: 1, status: `concurrent-${who}-${i}` }]);
  106 |       }
  107 |     }, who);
  108 |   await Promise.all([insertTen(a, "a"), insertTen(b, "b")]);
  109 |   const ids = (tab: Tab) => tab.evaluate(() => (window as unknown as { __ids?: unknown[] }).__ids ?? []);
> 110 |   await expect.poll(async () => (await ids(a)).length).toBe(20);
      |                                                        ^ Error: expect(received).toBe(expected) // Object.is equality
  111 |   await expect.poll(async () => (await ids(b)).length).toBe(20);
  112 |   expect(await ids(a)).toEqual(await ids(b));
  113 |   expect(new Set(await ids(a)).size).toBe(20);
  114 | });
  115 | 
  116 | test("the schema selector switches the sidebar to another schema", async ({ page }) => {
  117 |   await page.goto("/");
  118 |   await page.getByRole("combobox", { name: "Schema" }).click();
  119 |   await page.getByRole("option", { name: "billing" }).click();
  120 |   await page.getByRole("button", { name: "invoices", exact: true }).click();
  121 |   await expect(page.getByRole("columnheader", { name: /amount_cents/ })).toBeVisible();
  122 | });
  123 | 
```