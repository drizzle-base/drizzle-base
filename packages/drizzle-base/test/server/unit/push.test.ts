import { expect, test } from "bun:test";
import { pushOrClose } from "../../../src/server";

// Bun's send(): > 0 bytes sent, -1 queued under backpressure, 0 dropped. A dropped state frame closes the socket.
const fake = (ret: number) => {
  const closed: [number | undefined, string | undefined][] = [];
  return {
    ws: { send: () => ret, close: (code?: number, reason?: string) => void closed.push([code, reason]) },
    closed,
  };
};

test("a dropped frame closes the socket with 1013; a sent or queued one does not", () => {
  for (const [ret, expected] of [
    [0, [[1013, "backpressure"]]],
    [-1, []],
    [42, []],
  ] as const) {
    const f = fake(ret);
    pushOrClose(f.ws, { t: "pong" });
    expect(f.closed).toEqual(expected as unknown as [number, string][]);
  }
});
