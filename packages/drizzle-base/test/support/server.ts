// A running drizzle-base WebSocket server on the test application, and a raw client for it. Every wait is
// event-driven with a deadline; every client is closed when the test ends (an open WebSocket keeps the process alive).
import type { Server } from "bun";
import type { ServerFrame } from "../../src/protocol";
import { type ApiTree, type Conn, createHandler, type HandlerOptions } from "../../src/server";
import type { schema } from "./app";
import { type EngineHarness, withEngine } from "./engine";

export interface ServerHarness extends EngineHarness {
  url: string;
  server: Server<Conn>;
  handler: ReturnType<typeof createHandler<typeof schema>>;
  connect: (headers?: Record<string, string>) => Promise<TestClient>;
}

export interface TestClient {
  frames: ServerFrame[];
  send: (frame: unknown) => void;
  sendRaw: (text: string) => void;
  next: (pred: (f: ServerFrame) => boolean, ms?: number) => Promise<ServerFrame>;
  any: (pred: (f: ServerFrame) => boolean, ms?: number) => Promise<ServerFrame>;
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
}

function client(url: string, headers?: Record<string, string>): Promise<TestClient> {
  const ws = headers ? new WebSocket(url, { headers } as unknown as string[]) : new WebSocket(url);
  const frames: ServerFrame[] = [];
  const waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  const consumed = new Set<ServerFrame>();
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })),
  );
  ws.addEventListener("message", (e) => {
    const f = JSON.parse(String(e.data)) as ServerFrame;
    frames.push(f);
    for (const w of [...waiters])
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
  });
  const c: TestClient = {
    frames,
    send: (frame) => ws.send(JSON.stringify(frame)),
    sendRaw: (text) => ws.send(text),
    // The earliest frame matching `pred` that no earlier next() returned. Each frame is consumed once, but frames
    // whose relative order is not defined (two replies in flight) can be awaited in any order.
    next(pred, ms = 5_000) {
      const take = (f: ServerFrame) => {
        consumed.add(f);
        return f;
      };
      const hit = frames.find((f) => !consumed.has(f) && pred(f));
      if (hit) return Promise.resolve(take(hit));
      return Promise.race([
        new Promise<ServerFrame>((resolve) =>
          waiters.push({ pred: (f) => !consumed.has(f) && pred(f), resolve: (f) => resolve(take(f)) }),
        ),
        Bun.sleep(ms).then((): never => {
          throw new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(frames)}`);
        }),
      ]);
    },
    // Any frame matching `pred`, received at any time (for replies whose order is not defined).
    any(pred, ms = 5_000) {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return Promise.race([
        new Promise<ServerFrame>((resolve) => waiters.push({ pred, resolve })),
        Bun.sleep(ms).then((): never => {
          throw new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(frames)}`);
        }),
      ]);
    },
    closed,
    close: () => ws.close(),
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(c));
    ws.addEventListener("error", () => reject(new Error("could not connect")));
  });
}

export async function withServer(
  api: ApiTree,
  fn: (h: ServerHarness) => Promise<void>,
  opts: Omit<HandlerOptions<typeof schema>, "engine" | "api"> & { streamLagMs?: number; connections?: number } = {},
): Promise<void> {
  const { streamLagMs, connections, ...handlerOpts } = opts;
  await withEngine(
    async (h) => {
      const handler = createHandler({ engine: h.engine, api, ...handlerOpts });
      const server = Bun.serve<Conn>({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (req, s) => handler.upgrade(req, s) ?? undefined,
        websocket: handler.websocket,
      });
      const url = `ws://127.0.0.1:${server.port}`;
      const clients: TestClient[] = [];
      try {
        await fn({
          ...h,
          url,
          server,
          handler,
          connect: async (headers) => {
            const c = await client(url, headers);
            clients.push(c);
            return c;
          },
        });
      } finally {
        for (const c of clients) c.close();
        handler.close();
        await server.stop(true);
      }
    },
    { ...(streamLagMs === undefined ? {} : { streamLagMs }), ...(connections === undefined ? {} : { connections }) },
  );
}
