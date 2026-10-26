import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { createTestPaseoDaemon } from "../../../test-utils/paseo-daemon.js";
import { DaemonClient } from "../../../test-utils/daemon-client.js";
import { readActiveOmpEntryChain } from "./history.js";

test("replays a 300 MiB active chain without blocking the event loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-history-budget-"));
  const sessionFile = join(directory, "session.jsonl");
  try {
    const daemon = await createTestPaseoDaemon();
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.13.2",
    });
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      await client.getDaemonStatus();
      const file = await open(sessionFile, "w");
      const text = "x".repeat(16 * 1024);
      let bytes = 0;
      let count = 0;
      try {
        while (bytes < 300 * 1024 * 1024) {
          const line =
            JSON.stringify({
              type: "message",
              id: `row-${count}`,
              parentId: count ? `row-${count - 1}` : null,
              message: { role: "user", content: text },
            }) + "\n";
          bytes += Buffer.byteLength(line);
          await file.write(line);
          count++;
        }
      } finally {
        await file.close();
      }
      let last = performance.now();
      let longestGap = 0;
      const probe = setInterval(() => {
        const now = performance.now();
        longestGap = Math.max(longestGap, now - last);
        last = now;
      }, 5);
      try {
        const replayState = { finished: false };
        let repliesDuringReplay = 0;
        const replay = readActiveOmpEntryChain(sessionFile).finally(() => {
          replayState.finished = true;
        });
        // A real WebSocket RPC served by the isolated daemon on the same event loop.
        const requests = (async () => {
          while (!replayState.finished) {
            await client.getDaemonStatus();
            if (!replayState.finished) repliesDuringReplay++;
            await delay(10);
          }
        })();
        const [entries] = await Promise.all([replay, requests]);
        await delay(10);
        console.log(JSON.stringify({ bytes, count, longestGap, repliesDuringReplay }));
        expect(repliesDuringReplay).toBeGreaterThan(0);
        expect(entries.length).toBe(count);
        for (let index = 0; index < entries.length; index++) {
          expect(entries[index]).toEqual({
            type: "message",
            id: `row-${index}`,
            parentId: index ? `row-${index - 1}` : null,
            message: { role: "user", content: text },
          });
        }
        expect(longestGap).toBeLessThan(50);
      } finally {
        clearInterval(probe);
      }
    } finally {
      await client.close();
      await daemon.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
