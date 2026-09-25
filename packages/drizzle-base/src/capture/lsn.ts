// A WAL position as a number. Postgres prints "1/343C4E8"; pg-logical-replication zero-pads to
// "00000001/0343C4E8" — compared as strings the same barrier would never match (probed).
export function lsnToBigInt(lsn: string): bigint {
  const [hi = "0", lo = "0"] = lsn.split("/");
  return (BigInt(`0x${hi}`) << 32n) + BigInt(`0x${lo}`);
}
