// Keeps the capture running. On a failure: reset every subscription at once (spec D14 — subscribers are told,
// never served stale), stop the failed capture, prepare a new slot and check the capture again, start it, and
// resume the engine only then (P-M6: no snapshot predates the new slot). Retries with backoff until it succeeds
// or stop() is called. Single-flight: errors from an older capture are ignored, and a capture that dies while a
// restart is still finishing makes that restart go round again. stop() waits for a restart in progress and
// leaves no capture running. The dependencies are injected so the races are testable without a database.

export interface CaptureHandle {
  stop(): Promise<void>;
}

export interface SupervisorDeps {
  start(onError: () => void): Promise<CaptureHandle>; // a capture delivering to the engine
  prepare(): Promise<void>; // a new slot, and the capture checks again
  reset(): void;
  resume(): void;
  backoffMs?: (attempt: number) => number;
  onRestartError?: (e: unknown, attempt: number) => void;
}

export class CaptureSupervisor {
  private current: CaptureHandle | null = null;
  private generation = 0;
  private stopped = false;
  private restarting: Promise<void> | null = null;
  private failedAgain = false;
  private wake: (() => void) | null = null;

  constructor(private readonly deps: SupervisorDeps) {}

  async start(): Promise<void> {
    await this.startOne();
  }

  private async startOne(): Promise<void> {
    const mine = ++this.generation;
    this.current = await this.deps.start(() => {
      if (mine === this.generation) this.fail();
    });
  }

  private fail(): void {
    if (this.stopped) return;
    if (this.restarting !== null) {
      this.failedAgain = true;
      return;
    }
    this.restarting = this.restart().finally(() => {
      this.restarting = null;
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async restart(): Promise<void> {
    this.deps.reset();
    const backoff = this.deps.backoffMs ?? ((a) => Math.min(10_000, 250 * 2 ** (a - 1)));
    for (let attempt = 1; !this.stopped; attempt++) {
      this.failedAgain = false;
      try {
        await this.current?.stop();
        this.current = null;
        await this.deps.prepare();
        if (this.stopped) return;
        await this.startOne();
        if (this.stopped) return; // stop() ran meanwhile: it stops this.current after awaiting us
        if (!this.failedAgain) {
          this.deps.resume();
          return;
        }
      } catch (e) {
        this.deps.onRestartError?.(e, attempt);
      }
      await this.sleep(backoff(attempt));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.restarting;
    await this.current?.stop();
    this.current = null;
  }
}
