// Restarting capture after a failure recreates the SLOT only: the publication the boot validated stays as it is.
// A slot still held by a consumer cannot be dropped, and that must fail loudly — keeping the old slot silently
// would be claimed as "a new slot" by the caller.
import { expect, test } from "bun:test";
import { PgoutputCapture, recreateSlot } from "../../../src/capture";
import { withApp } from "../../support/app";
import { pgConfig } from "../../support/db";

test("recreateSlot gives a new slot and leaves the publication alone", async () => {
  await withApp(async (sql, names) => {
    const [before] = await sql`select pg_current_wal_lsn()::text as l`;
    await sql.unsafe(`insert into dzb_app.users(name) values ('advance the WAL')`);
    const [pub] = await sql`select oid::int as oid from pg_publication where pubname = ${names.publication}`;
    await recreateSlot(sql, names.slot);
    const [slot] = await sql`select restart_lsn::text as r from pg_replication_slots where slot_name = ${names.slot}`;
    expect(slot).toBeDefined();
    const [{ newer }] = await sql`select ${slot?.r}::pg_lsn > ${before?.l}::pg_lsn as newer`;
    expect(newer).toBe(true); // a fresh slot starts at the current WAL position
    const [pubAfter] = await sql`select oid::int as oid from pg_publication where pubname = ${names.publication}`;
    expect(pubAfter?.oid).toBe(pub?.oid);
  });
});

test("recreateSlot refuses a slot that stays active", async () => {
  await withApp(async (sql, names) => {
    const cap = new PgoutputCapture({ connection: pgConfig, names });
    await cap.start({ onEvent: () => {}, onError: () => {} });
    try {
      await expect(recreateSlot(sql, names.slot, 500)).rejects.toThrow(/still active/);
    } finally {
      await cap.stop();
    }
  });
});
