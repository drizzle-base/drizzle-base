// THROWAWAY SPIKE (P1) — run the corpus through the analyzer and print a per-case read-set.
import { analyzeSql, exprText } from "./analyze";
import { captureAll } from "./capture";

const fmtB = (b: { col: string; op: string; value: unknown }) => `${b.col} ${b.op} ${JSON.stringify(b.value)}`;
const tally: Record<string, number> = {};
for (const c of await captureAll()) {
	console.log(`\n## ${c.id}  [${c.cat}]`);
	for (const s of c.stmts) {
		const r = analyzeSql(s.sql, s.params);
		if (r.error) console.log(`   PARSE ERROR: ${r.error}`);
		for (const a of r.accesses) {
			tally[a.tier!] = (tally[a.tier!] ?? 0) + 1;
			const det = [
				...a.bounds.map((ors) => ors.map(fmtB).join(" OR ")),
				a.anchoredBy ?? "",
				...a.preds.map((p) => `pred ${exprText(p)}`),
			].filter(Boolean).join("; ");
			console.log(`   ${a.tier!.padEnd(9)} ${a.table}${a.alias !== a.table ? ` as ${a.alias}` : ""}  @${a.where}  ${det}${a.dropped.length ? `  | dropped: ${a.dropped.join(", ")}` : ""}`);
		}
		for (const f of r.flags) console.log(`   · ${f}`);
	}
}
console.log("\nTALLY (scans):", tally);
