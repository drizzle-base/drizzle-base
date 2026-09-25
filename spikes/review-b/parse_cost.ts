// Review B probe: libpg-query (WASM) under Bun — load time, parse cost over the P1 corpus, cache-hit cost.
const t0 = performance.now();
const lib = await import("libpg-query");
const tImport = performance.now() - t0;
const t1 = performance.now();
await lib.loadModule();
const tLoad = performance.now() - t1;
const text = await Bun.file("../p1-extract/captured.txt").text();
const sqls: string[] = [];
const lines = text.split("\n");
for (let i = 0; i < lines.length; i++) if (lines[i].startsWith("## ")) { const s = lines[i + 1]; const j = s.lastIndexOf(" ["); sqls.push(j > 0 ? s.slice(0, j) : s); }
let fails = 0;
const tc = performance.now();
const first = lib.parseSync(sqls[0]); const tFirst = performance.now() - tc;
for (const s of sqls) { try { lib.parseSync(s); } catch { fails++; } }
const N = 20;
const t2 = performance.now();
for (let k = 0; k < N; k++) for (const s of sqls) { try { lib.parseSync(s); } catch {} }
const per = (performance.now() - t2) / (N * sqls.length);
// longest statement
const longest = sqls.reduce((a, b) => (b.length > a.length ? b : a));
const t3 = performance.now();
for (let k = 0; k < 500; k++) lib.parseSync(longest);
const perLong = (performance.now() - t3) / 500;
// the cache path the spec proposes: Map by SQL text
const cache = new Map<string, unknown>(); for (const s of sqls) { try { cache.set(s, lib.parseSync(s)); } catch {} }
const t4 = performance.now(); let h = 0;
for (let k = 0; k < 200000; k++) if (cache.get(sqls[k % sqls.length])) h++;
const perHit = (performance.now() - t4) / 200000;
// JSON size of the AST (the WASM returns JSON that is JSON.parsed)
const astBytes = JSON.stringify(lib.parseSync(longest)).length;
// the literal-inlining hazard: drizzle's sql.raw / inlined values make distinct texts per call
const rss = process.memoryUsage().rss / 1e6;
console.log(JSON.stringify({ bun: Bun.version, n: sqls.length, fails, tImport_ms: +tImport.toFixed(1), tLoad_ms: +tLoad.toFixed(1), tFirst_ms: +tFirst.toFixed(3), perParse_us: +(per * 1000).toFixed(1), longestChars: longest.length, perParseLongest_us: +(perLong * 1000).toFixed(1), perCacheHit_ns: +(perHit * 1e6).toFixed(0), astJsonBytes_longest: astBytes, rss_mb: +rss.toFixed(0) }));
