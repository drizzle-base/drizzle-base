// The change feed: pgoutput streamed over the walsender (spec P-A2). Polling the slot was rejected — every
// poll rebuilds the decoding context from restart_lsn (41→204 ms per poll behind one open transaction) and a
// bulk transaction arrives as one unbounded batch.
//
// Delivery contract: events reach onEvent in commit order, one at a time (flowControl awaits the handler), and
// a transaction is acknowledged only after its handler resolved. A crash before that means the
// server re-sends it on the next start — at-least-once, which is harmless: re-invalidating is only cost.

import type { SQL } from "bun";
import { LogicalReplicationService, type Pgoutput, PgoutputPlugin } from "pg-logical-replication";
import { TxnAssembler } from "./assembler";
import { emitBarrier } from "./barrier";
import { log } from "./log";
import { assertCaptureNames, type CaptureNames } from "./setup";
import type { StreamEvent } from "./types";

export interface PgConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface CaptureHandlers {
  onEvent: (e: StreamEvent) => Promise<void> | void;
  onError: (e: Error) => void;
}

export class PgoutputCapture {
  private service: LogicalReplicationService | null = null;
  private lastAcked = "0/0";
  // After the first failure nothing more is delivered or acknowledged: acknowledging a later transaction
  // would confirm past the one that failed, and the server would never send it again. The caller drops every
  // subscription and restarts the capture (spec D14, P-M6).
  private failed = false;

  private watchdog: ReturnType<typeof setInterval> | null = null;

  // livenessMs: the longest silence tolerated from the server. It pings at least every wal_sender_timeout / 2
  // (it asks for a reply, which we give), so the default of 2× the server's 60 s default is generous.
  private advancer: ReturnType<typeof setInterval> | null = null;

  // advance: the slot moves only when something is acknowledged, and only published transactions and barriers
  // reach us. WAL written by anything else (other schemas, other databases, vacuum) would be retained forever on
  // a database whose app is quiet; a barrier every `everyMs` gives the stream something to acknowledge.
  constructor(
    private readonly opts: {
      connection: PgConnection;
      names: CaptureNames;
      rowCap?: number;
      livenessMs?: number;
      advance?: { sql: SQL; everyMs: number };
    },
  ) {
    assertCaptureNames(opts.names);
  }

  // Resolves once the server accepted START_REPLICATION; rejects on anything that stops it from getting there
  // (missing or invalidated slot, bad credentials, wrong database), so boot fails closed instead of hanging.
  // A slot still held by a consumer that is shutting down ("is active for PID") is retried for up to ~10 s.
  async start(h: CaptureHandlers): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.open(h);
        return;
      } catch (e) {
        const busy = e instanceof Error && /is active for PID/.test(e.message);
        if (!busy || attempt >= 40) throw e;
        await Bun.sleep(250);
      }
    }
  }

  private open(h: CaptureHandlers): Promise<void> {
    const assembler = new TxnAssembler(this.opts.rowCap ?? 10_000);
    const service = new LogicalReplicationService(
      { ...this.opts.connection, keepAlive: true },
      {
        acknowledge: { auto: false, timeoutSeconds: 0 },
        flowControl: { enabled: true },
      },
    );
    this.service = service;
    this.failed = false;
    let started = false;
    return new Promise<void>((resolve, reject) => {
      const fail = (e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (!started) {
          this.service = null;
          void service.destroy().catch(() => {});
          reject(err);
          return;
        }
        this.clearTimers();
        this.failed = true;
        log.error("capture stream failed", { slot: this.opts.names.slot, error: err.message });
        h.onError(err);
      };
      let lastSeen = Date.now();
      // biome-ignore lint/nursery/noMisusedPromises: with flowControl the library awaits this listener (emitAsync), and every error is caught inside
      service.on("data", async (_lsn: string, msg: Pgoutput.Message) => {
        lastSeen = Date.now();
        if (this.failed) return;
        try {
          const ev = assembler.feed(msg);
          if (!ev) return;
          await h.onEvent(ev);
          // acknowledge() reports "last byte received + 1", i.e. it adds one to what it is given. Passing the
          // commit record's START makes the confirmed position commitLsn + 1: past this commit (so it is not
          // redelivered) and never past the end of the WAL. Passing commitEndLsn would confirm one byte beyond
          // the end, and the next record — typically a barrier — would be skipped as already confirmed.
          // A barrier's own start is acknowledged the same way: every transaction that committed before it has
          // been delivered and handled (commit order, one handler at a time), so the slot may move past it.
          const ackAt = ev.kind === "txn" ? ev.txn.commitLsn : ev.lsn;
          if (ackAt) {
            this.lastAcked = ackAt;
            await service.acknowledge(ackAt);
          }
        } catch (e) {
          fail(e);
        }
      });
      // With manual acknowledgement nothing else answers the server's keepalives; an unanswered one ends the
      // connection after wal_sender_timeout.
      // Emitted with a plain emit(): nobody awaits it, so the reply is fire-and-forget with its failure routed to fail().
      service.on("heartbeat", (_lsn: string, _ts: number, shouldRespond: boolean) => {
        lastSeen = Date.now();
        if (shouldRespond) void service.acknowledge(this.lastAcked).catch(fail);
      });
      service.on("error", fail);
      service.on("start", () => {
        started = true;
        lastSeen = Date.now();
        // A connection that dies without a FIN (a black-holed network, a frozen server) raises no error:
        // only silence reveals it. Past the deadline the socket is destroyed and the failure reported.
        const limit = this.opts.livenessMs ?? 120_000;
        this.watchdog = setInterval(
          () => {
            if (Date.now() - lastSeen <= limit) return;
            void service.destroy().catch(() => {});
            fail(new Error(`no message from the server for ${Math.round((Date.now() - lastSeen) / 1000)} s`));
          },
          Math.min(1_000, limit / 4),
        );
        const adv = this.opts.advance;
        if (adv) {
          let n = 0;
          this.advancer = setInterval(() => {
            void emitBarrier(adv.sql, `drizzle-base.advance.${++n}`).catch((e) =>
              log.warn("advance barrier failed", { error: String(e) }),
            );
          }, adv.everyMs);
        }
        resolve();
      });
      const plugin = new PgoutputPlugin({
        protoVersion: 1,
        publicationNames: [this.opts.names.publication],
        messages: true,
      });
      service.subscribe(plugin, this.opts.names.slot).catch(fail);
    });
  }

  // A handler that never settles would keep stop() waiting on flow control; after 2 s the socket is destroyed.
  // Nothing is lost: an unacknowledged transaction is re-sent on the next start.
  private clearTimers(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.advancer) clearInterval(this.advancer);
    this.watchdog = null;
    this.advancer = null;
  }

  async stop(): Promise<void> {
    this.clearTimers();
    const s = this.service;
    this.service = null;
    if (!s) return;
    const stopped = await Promise.race([s.stop().then(() => true), Bun.sleep(2_000).then(() => false)]);
    if (!stopped) await s.destroy();
  }
}
