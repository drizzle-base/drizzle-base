/** mulberry32: a tiny seeded PRNG, so every tab builds the same dataset from the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUIDv7-shaped id: 48-bit millisecond timestamp, version 7, RFC 4122 variant, the rest from `rand`. */
export function uuidv7(ms: number, rand: () => number): string {
  const hex = ms.toString(16).padStart(12, "0");
  const digits = (n: number): string => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  const variant = (8 + Math.floor(rand() * 4)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${digits(3)}-${variant}${digits(3)}-${digits(12)}`;
}
