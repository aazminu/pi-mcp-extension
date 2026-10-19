import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createLineSplitter,
  ensurePidTerminated,
  instrumentStdioTransport,
  isPidAlive,
  type StdioProcessDeps,
} from "../src/stdio-process.js";

function createEsrchError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("kill ESRCH");
  err.code = "ESRCH";
  return err;
}

function createEpermError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("kill EPERM");
  err.code = "EPERM";
  return err;
}

describe("stdio-process", () => {
  describe("createLineSplitter", () => {
    it("splits lines across arbitrary chunk boundaries and flushes trailing content once on end()", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      splitter.write(Buffer.from("first ", "utf8"));
      assert.deepEqual(lines, []);

      splitter.write(Buffer.from("line\nsec", "utf8"));
      assert.deepEqual(lines, ["first line"]);

      splitter.write(Buffer.from("ond line\n\nthird", "utf8"));
      assert.deepEqual(lines, ["first line", "second line", ""]);

      splitter.end();
      assert.deepEqual(lines, ["first line", "second line", "", "third"]);

      // Idempotent: subsequent end() calls must not re-emit
      splitter.end();
      assert.deepEqual(lines, ["first line", "second line", "", "third"]);
    });

    it("reassembles multi-byte UTF-8 code points split across chunk boundaries", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      // "🚀" is 4 bytes (F0 9F 9A 80); "é" is 2 bytes (C3 A9)
      const fullPayload = Buffer.from("launch 🚀 pad\ncafé", "utf8");
      const rocketOffset = fullPayload.indexOf(0xf0);
      assert.ok(rocketOffset > 0);

      // Split right inside the 4-byte emoji and inside the 2-byte accented char
      const chunk1 = fullPayload.subarray(0, rocketOffset + 2);
      const chunk2 = fullPayload.subarray(rocketOffset + 2, fullPayload.length - 1);
      const chunk3 = fullPayload.subarray(fullPayload.length - 1);

      splitter.write(chunk1);
      assert.deepEqual(lines, []);

      splitter.write(chunk2);
      assert.deepEqual(lines, ["launch 🚀 pad"]);

      splitter.write(chunk3);
      splitter.end();
      splitter.end();

      assert.deepEqual(lines, ["launch 🚀 pad", "café"]);
    });

    it("does not emit on end() when there is no trailing remainder", () => {
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));

      splitter.write(Buffer.from("complete\n", "utf8"));
      splitter.end();
      splitter.end();

      assert.deepEqual(lines, ["complete"]);
    });
  });

  describe("instrumentStdioTransport", () => {
    it("captures PID early during start(), memoizes close(), and flushes stderr once across end and close", async () => {
      const stderrStream = new EventEmitter();
      const capturedPids: number[] = [];
      const stderrLines: string[] = [];
      let closeCallCount = 0;
      let resolveStart!: () => void;

      interface FakeStdioTransport {
        _process: { pid?: number } | undefined;
        pid: number | null;
        stderr: EventEmitter | null;
        start(): Promise<void>;
        close(): Promise<void>;
      }

      const fakeTransport: FakeStdioTransport = {
        _process: undefined,
        pid: null,
        stderr: stderrStream,
        start(): Promise<void> {
          fakeTransport._process = { pid: 4242 };
          return new Promise<void>((resolve) => {
            resolveStart = () => {
              fakeTransport.pid = 4242;
              resolve();
            };
          });
        },
        close(): Promise<void> {
          closeCallCount += 1;
          fakeTransport._process = undefined;
          return Promise.resolve();
        },
      };

      instrumentStdioTransport(fakeTransport as unknown as StdioClientTransport, {
        onPid: (pid) => capturedPids.push(pid),
        onStderrLine: (line) => stderrLines.push(line),
      });

      const startPromise = fakeTransport.start();
      // PID captured synchronously before start() resolves
      assert.deepEqual(capturedPids, [4242]);

      resolveStart();
      await startPromise;
      assert.deepEqual(capturedPids, [4242, 4242]);

      // Memoized close()
      const close1 = fakeTransport.close();
      const close2 = fakeTransport.close();
      assert.equal(close1, close2);
      await Promise.all([close1, close2]);
      assert.equal(closeCallCount, 1);

      // Stderr line splitting and idempotent flush across end + close
      stderrStream.emit("data", Buffer.from("warn 1\nwarn ", "utf8"));
      stderrStream.emit("data", Buffer.from("2", "utf8"));
      stderrStream.emit("end");
      stderrStream.emit("close");
      assert.deepEqual(stderrLines, ["warn 1", "warn 2"]);
    });

    it("falls back to transport.pid when _process.pid is unavailable", async () => {
      const capturedPids: number[] = [];
      const fakeTransport = {
        pid: 7777,
        stderr: null,
        start(): Promise<void> {
          return Promise.resolve();
        },
        close(): Promise<void> {
          return Promise.resolve();
        },
      } as unknown as StdioClientTransport;

      instrumentStdioTransport(fakeTransport, {
        onPid: (pid) => capturedPids.push(pid),
        onStderrLine: () => {},
      });

      await fakeTransport.start();
      assert.deepEqual(capturedPids, [7777]);
    });
  });

  describe("isPidAlive & ensurePidTerminated", () => {
    it("isPidAlive returns true on signal 0 success or EPERM, and false on ESRCH", () => {
      assert.equal(
        isPidAlive(100, {
          kill: () => true,
        }),
        true,
      );
      assert.equal(
        isPidAlive(100, {
          kill: () => {
            throw createEpermError();
          },
        }),
        true,
      );
      assert.equal(
        isPidAlive(100, {
          kill: () => {
            throw createEsrchError();
          },
        }),
        false,
      );
    });

    it("is a no-op when pid is null, undefined, 0, or already dead", async () => {
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const deps: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signals.push(signal);
          throw createEsrchError();
        },
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
        now: () => 0,
      };

      await ensurePidTerminated(null, deps);
      await ensurePidTerminated(undefined, deps);
      await ensurePidTerminated(0, deps);
      assert.deepEqual(signals, []);

      await ensurePidTerminated(1234, deps);
      assert.deepEqual(signals, [0]);
    });

    it("stops waiting as soon as process exits after SIGTERM", async () => {
      let currentNow = 1_000;
      let aliveChecksAfterTerm = 0;
      let alive = true;
      const calls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (pid, signal) => {
          calls.push({ pid, signal });
          if (signal === 0) {
            if (!alive) {
              throw createEsrchError();
            }
            if (calls.some((c) => c.signal === "SIGTERM")) {
              aliveChecksAfterTerm += 1;
              if (aliveChecksAfterTerm >= 3) {
                alive = false;
                throw createEsrchError();
              }
            }
            return true;
          }
          return true;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
        },
        now: () => currentNow,
      };

      await ensurePidTerminated(5555, deps);

      assert.ok(calls.some((c) => c.signal === "SIGTERM"));
      assert.ok(!calls.some((c) => c.signal === "SIGKILL"));
      assert.deepEqual(sleeps, [25, 25]);
    });

    it("escalates SIGTERM → bounded wait → SIGKILL when process ignores SIGTERM", async () => {
      let currentNow = 10_000;
      let killedWithSigkill = false;
      let postKillPolls = 0;
      const signals: Array<NodeJS.Signals | number | undefined> = [];
      const sleeps: number[] = [];

      const deps: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === 0) {
            if (killedWithSigkill) {
              postKillPolls += 1;
              if (postKillPolls >= 2) {
                throw createEsrchError();
              }
            }
            return true;
          }
          if (signal === "SIGKILL") {
            killedWithSigkill = true;
          }
          return true;
        },
        sleep: async (ms) => {
          sleeps.push(ms);
          currentNow += ms;
        },
        now: () => currentNow,
      };

      await ensurePidTerminated(9999, deps);

      const nonZeroSignals = signals.filter((s) => s !== 0);
      assert.deepEqual(nonZeroSignals, ["SIGTERM", "SIGKILL"]);
      // 500ms SIGTERM window in 25ms increments (20 sleeps) + 1 sleep after SIGKILL before 2nd poll sees ESRCH
      assert.equal(sleeps.length, 21);
      assert.ok(sleeps.every((ms) => ms === 25));
    });

    it("handles ESRCH thrown directly by kill(SIGTERM) or kill(SIGKILL)", async () => {
      let currentNow = 0;
      const depsTermRace: StdioProcessDeps = {
        kill: (_pid, signal) => {
          if (signal === "SIGTERM") {
            throw createEsrchError();
          }
          return true;
        },
        sleep: async () => {
          throw new Error("should not sleep when SIGTERM sees ESRCH");
        },
        now: () => currentNow,
      };
      await ensurePidTerminated(1111, depsTermRace);

      const signalsKillRace: Array<NodeJS.Signals | number | undefined> = [];
      const depsKillRace: StdioProcessDeps = {
        kill: (_pid, signal) => {
          signalsKillRace.push(signal);
          if (signal === "SIGKILL") {
            throw createEsrchError();
          }
          return true;
        },
        sleep: async (ms) => {
          currentNow += ms;
        },
        now: () => currentNow,
      };
      await ensurePidTerminated(2222, depsKillRace);
      assert.deepEqual(
        signalsKillRace.filter((s) => s !== 0),
        ["SIGTERM", "SIGKILL"],
      );
    });
  });
});
