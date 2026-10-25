import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROVIDER_CAPABILITIES,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import contribute from "../index.server.js";

// Run with an installed Roder binary; mock inference keeps the protocol check offline.
const roderBinary = process.env.RODER_TEST_BINARY;

describe.skipIf(!roderBinary)("Roder ACP plugin with the real CLI", () => {
  let directory: string;
  let connection: ProviderConnection;
  let events: ProviderEvent[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "paseo-roder-"));
    const registrations: ProviderRegistration[] = [];
    contribute({ registerProvider: (registration) => registrations.push(registration) });
    expect(registrations).toHaveLength(1);
    const provider = registrations[0];
    expect(provider).toMatchObject({
      id: "roder",
      label: "Roder",
      requiresConfiguration: true,
      command: ["roder", "acp"],
    });
    connection = await provider.connect({
      versions: [1],
      capabilities: PROVIDER_CAPABILITIES,
      launch: {
        command: roderBinary ?? "roder",
        args: ["acp", "--config-dir", path.join(directory, "config")],
        env: { ...process.env, RODER_PROVIDER: "mock", RODER_MODEL: "mock" },
      },
    });
    events = [];
    connection.onEvent((event) => events.push(event));
  });

  afterEach(async () => {
    await connection?.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function waitForEvent(expected: Partial<ProviderEvent>): Promise<void> {
    await expect
      .poll(() => events, { timeout: 10_000 })
      .toContainEqual(expect.objectContaining(expected));
  }

  function openInput(): Extract<ProviderInput, { type: "session.open" }> {
    return {
      type: "session.open",
      requestId: "open",
      sessionId: "session",
      config: { cwd: directory, env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    };
  }

  it("opens a text session, streams a response, and closes its process", async () => {
    expect(connection.capabilities).not.toContain("session.persistence");
    expect(connection.capabilities).not.toContain("session.list");
    expect(connection.capabilities).not.toContain("prompt.image");
    await connection.send({ type: "catalog", requestId: "catalog" });
    await waitForEvent({ type: "catalog", catalog: { models: [], modes: [] } });
    await connection.send(openInput());
    await waitForEvent({ type: "session.ready", sessionId: "session" });
    await connection.send({
      type: "session.prompt",
      sessionId: "session",
      prompt: {
        clientMessageId: "message",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "Say hello" }] },
      },
    });
    await waitForEvent({ type: "session.turn", sessionId: "session", state: "completed" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "timeline.item",
        sessionId: "session",
        item: expect.objectContaining({ type: "assistant_message", text: "hello from roder" }),
      }),
    );
    await connection.send({ type: "session.close", requestId: "close", sessionId: "session" });
    await waitForEvent({ type: "session.closed", sessionId: "session" });
    expect(events.filter((event) => event.type === "request.failed")).toEqual([]);
  });

  it("rejects restoration without claiming persistent-session support", async () => {
    await expect(
      connection.send({
        ...openInput(),
        persistence: { version: 1, data: { sessionId: "previous-session" } },
      }),
    ).rejects.toThrow("Provider does not support session.persistence");
    expect(events).toEqual([]);
  });

  it("reports unsupported injected MCP servers as an open failure", async () => {
    const input = openInput();
    input.config.mcpServers = { example: { type: "stdio", command: "example-mcp", args: [] } };
    await connection.send(input);
    await waitForEvent({ type: "request.failed", requestId: "open" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "request.failed",
        error: expect.objectContaining({
          message: expect.stringContaining("mcpServers are not advertised by Roder ACP"),
        }),
      }),
    );
    expect(events.filter((event) => event.type === "session.ready")).toEqual([]);
  });
});
