// The change feed: pgoutput streamed over the walsender (spec P-A2). Polling the slot was rejected — every
// poll rebuilds the decoding context from restart_lsn (41→204 ms per poll behind one open transaction) and a
// bulk transaction arrives as one unbounded batch.
//
// Delivery contract: events reach onEvent in commit order, one at a time (flowControl awaits the handler), and
// a transaction is acknowledged only after its handler resolved. A crash before that means the
// server re-sends it on the next start — at-least-once, which is harmless: re-invalidating is only cost.
import { LogicalReplicationService, type Pgoutput, PgoutputPlugin } from "pg-logical-replication";
import { log } from "../log";
import { TxnAssembler } from "./assembler";
import type { CaptureNames } from "./setup";
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

	constructor(private readonly opts: { connection: PgConnection; names: CaptureNames; rowCap?: number }) {}

	async start(h: CaptureHandlers): Promise<void> {
		const assembler = new TxnAssembler(this.opts.rowCap ?? 10_000);
		const service = new LogicalReplicationService(this.opts.connection, {
			acknowledge: { auto: false, timeoutSeconds: 0 },
			flowControl: { enabled: true },
		});
		this.service = service;
		this.failed = false;
		const fail = (e: unknown) => {
			this.failed = true;
			const err = e instanceof Error ? e : new Error(String(e));
			log.error("capture stream failed", { slot: this.opts.names.slot, error: err.message });
			h.onError(err);
		};
		service.on("data", async (_lsn: string, msg: Pgoutput.Message) => {
			if (this.failed) return;
			try {
				const ev = assembler.feed(msg);
				if (!ev) return;
				await h.onEvent(ev);
				// acknowledge() reports "last byte received + 1", i.e. it adds one to what it is given. Passing the
				// commit record's START makes the confirmed position commitLsn + 1: past this commit (so it is not
				// redelivered) and never past the end of the WAL. Passing commitEndLsn would confirm one byte beyond
				// the end, and the next record — typically a barrier — would be skipped as already confirmed.
				if (ev.kind === "txn" && ev.txn.commitLsn) {
					this.lastAcked = ev.txn.commitLsn;
					await service.acknowledge(ev.txn.commitLsn);
				}
			} catch (e) {
				fail(e);
			}
		});
		// With manual acknowledgement nothing else answers the server's keepalives; an unanswered one ends the
		// connection after wal_sender_timeout.
		service.on("heartbeat", async (_lsn: string, _ts: number, shouldRespond: boolean) => {
			if (shouldRespond) await service.acknowledge(this.lastAcked).catch(fail);
		});
		service.on("error", fail);
		const live = new Promise<void>((resolve) => service.on("start", () => resolve()));
		const plugin = new PgoutputPlugin({ protoVersion: 1, publicationNames: [this.opts.names.publication], messages: true });
		service.subscribe(plugin, this.opts.names.slot).catch(fail);
		await live;
	}

	// A handler that never settles would keep stop() waiting on flow control; after 2 s the socket is destroyed.
	// Nothing is lost: an unacknowledged transaction is re-sent on the next start.
	async stop(): Promise<void> {
		const s = this.service;
		this.service = null;
		if (!s) return;
		const stopped = await Promise.race([s.stop().then(() => true), Bun.sleep(2_000).then(() => false)]);
		if (!stopped) await s.destroy();
	}
}
