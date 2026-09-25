// REVIEW-A probe: can two scans anchor on each other (a key-query cycle)? Run from spikes/p1-extract.
import { analyzeSql } from "../p1-extract/analyze";
for (const s of [
	`select * from users a inner join users b on a.manager_id = b.id`,
	`select * from posts p inner join comments c on c.post_id = p.id`,
	`select * from users a inner join users b on a.manager_id = b.id where a.age = 30`,
]) {
	const a = analyzeSql(s, []);
	console.log(s, "\n  ", a.accesses.map((x) => `${x.alias}:${x.tier} anchor→${x.anchorEdge?.toAccess?.alias ?? "-"}`).join("  "));
}
process.exit(0);
