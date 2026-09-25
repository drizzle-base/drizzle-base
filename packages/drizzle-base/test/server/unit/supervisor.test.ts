// The capture restart logic, with fake captures: deterministic where the real thing is a race.
import { expect, test } from "bun:test";
import { CaptureSupervisor } from "../../../src/server";
import { deferred } from "../../support/hooks";

function fakes() {
  const log: string[] = [];
  const live = new Set<number>();
  const errors: (() => void)[] = [];
  let n = 0;
  let prepareGate: Promise<void> | null = null;
  let startGate: Promise<void> | null = null;
  let failNextStart = false;
  const deps = {
    start: async (onError: () => void) => {
      const id = ++n;
      if (startGate && id > 1) await startGate; // a new capture still starting
      live.add(id);
      errors[id] = onError;
      log.push(`start ${id}`);
      if (failNextStart) {
        failNextStart = false;
        queueMicrotask(onError); // dies right after starting
      }
      return {
        stop: async () => {
          live.delete(id);
          log.push(`stop ${id}`);
        },
      };
    },
    prepare: async () => {
      log.push("prepare");
      if (prepareGate) await prepareGate;
    },
    reset: () => log.push("reset"),
    resume: () => log.push("resume"),
    backoffMs: () => 5,
  };
  return {
    deps,
    log,
    live,
    fail: (id: number) => errors[id]?.(),
    holdPrepare: (p: Promise<void> | null) => {
      prepareGate = p;
    },
    holdStart: (p: Promise<void> | null) => {
      startGate = p;
    },
    failNextStart: () => {
      failNextStart = true;
    },
  };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await Bun.sleep(5);
  expect(cond()).toBe(true);
};

test("a failure resets first, recreates, restarts, and resumes last", async () => {
  const f = fakes();
  const s = new CaptureSupervisor(f.deps);
  await s.start();
  f.fail(1);
  await until(() => f.log.includes("resume"));
  expect(f.log).toEqual(["start 1", "reset", "stop 1", "prepare", "start 2", "resume"]);
  await s.stop();
  expect(f.live.size).toBe(0);
});

test("stop() during a restart waits for it and leaves no capture running", async () => {
  for (const hold of ["prepare", "start"] as const) {
    const f = fakes();
    const s = new CaptureSupervisor(f.deps);
    await s.start();
    const gate = deferred();
    if (hold === "prepare") f.holdPrepare(gate.promise);
    else f.holdStart(gate.promise); // the new capture is starting when stop() arrives
    f.fail(1);
    await until(() => f.log.includes("prepare"));
    const stopped = s.stop();
    gate.resolve();
    await stopped;
    expect({ hold, live: f.live.size }).toEqual({ hold, live: 0 });
    expect(f.log).not.toContain("resume");
  }
});

test("an error from an older capture never restarts the newer one", async () => {
  const f = fakes();
  const s = new CaptureSupervisor(f.deps);
  await s.start();
  f.fail(1);
  await until(() => f.log.includes("resume"));
  f.fail(1); // the old capture reports again, late
  await Bun.sleep(30);
  expect(f.log.filter((x) => x === "reset").length).toBe(1);
  await s.stop();
});

test("a capture that dies while the restart finishes is restarted again, with backoff, and resumed once", async () => {
  const f = fakes();
  const s = new CaptureSupervisor(f.deps);
  await s.start();
  f.failNextStart();
  f.fail(1);
  await until(() => f.log.includes("resume"));
  expect(f.log.filter((x) => x === "prepare").length).toBe(2);
  expect(f.log.filter((x) => x === "resume").length).toBe(1);
  expect(f.live.size).toBe(1);
  await s.stop();
  expect(f.live.size).toBe(0);
});
