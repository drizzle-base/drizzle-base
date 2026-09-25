import { expect, test } from "bun:test";
import { withEngine } from "../../support/engine";

test("with no subscription at all, the buffer stays bounded under a write workload", async () => {
  await withEngine(
    async ({ sql: pool, engine }) => {
      let peak = 0;
      for (let i = 0; i < 200; i++) {
        await pool.unsafe(`insert into dzb_app.users(name) values ('u${i}')`);
        peak = Math.max(peak, engine.bufferSize);
      }
      await Bun.sleep(300);
      expect(peak).toBeGreaterThan(0);
      expect(engine.bufferSize).toBeLessThan(20);
    },
    { pruneEveryMs: 50 },
  );
});
