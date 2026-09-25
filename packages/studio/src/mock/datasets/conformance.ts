import { col, type MockDataset, mockTable, mockView } from "../dataset";

/**
 * The relations the conformance suite (test/conformance.ts) runs against, empty. A real backend creates them as:
 *
 *   create schema conformance;
 *   create table conformance.items (id serial primary key, label text not null, rank integer, note text);
 *   create table conformance.log (at timestamptz not null default now(), msg text);
 *   create view conformance.items_view as select * from conformance.items;
 */
export function conformanceDataset(): MockDataset {
  const columns = [
    col("id", "integer", "integer", { isPrimaryKey: true, nullable: false }),
    col("label", "text", "text", { nullable: false }),
    col("rank", "integer", "integer"),
    col("note", "text", "text"),
  ];
  return {
    tables: [
      mockTable("conformance", "items", columns, [], { id: "serial" }),
      mockTable(
        "conformance",
        "log",
        [col("at", "timestamptz", "timestamp with time zone", { nullable: false }), col("msg", "text", "text")],
        [],
        { at: "now" },
      ),
    ],
    views: [mockView("conformance", "items_view", columns, (read) => read("conformance.items").map((r) => ({ ...r })))],
  };
}
