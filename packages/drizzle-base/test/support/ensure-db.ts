// Creates this checkout's test database if it does not exist yet (see testdb.ts). Run by `bun run test` before
// the suite; idempotent. It connects to the maintenance database `postgres` only to issue CREATE DATABASE, and only
// for a name the test guard accepts.
import { SQL } from "bun";
import { assertTestDatabase, pgConfig } from "./db";

assertTestDatabase(pgConfig.database);
const admin = new SQL({
  hostname: pgConfig.host,
  port: pgConfig.port,
  database: "postgres",
  username: pgConfig.user,
  password: pgConfig.password,
  max: 1,
  prepare: false,
});
try {
  const [row] = await admin`select 1 as ok from pg_database where datname = ${pgConfig.database}`;
  if (!row)
    await admin.unsafe(`create database "${pgConfig.database}"`).catch((e: unknown) => {
      // another run in this checkout created it between the check and here
      if ((e as { errno?: string }).errno !== "42P04") throw e;
    });
} finally {
  await admin.close();
}
