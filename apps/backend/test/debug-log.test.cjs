const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { DevelopmentDebugLog } = require("../build/debug-log");

test("redacts private values while keeping useful diagnostic context", () => {
  const directory = mkdtempSync(join(tmpdir(), "roll-together-debug-"));
  const path = join(directory, "diagnostics.jsonl");

  try {
    const log = new DevelopmentDebugLog(path);
    log.record({
      level: "error",
      source: "test",
      event: "example_failure",
      details: {
        username: "Private Person",
        roomId: "ABCDEFGHIJKLMNOPQRST",
        socketId: "socket-identifier",
        episodePath: "/watch/SECRET123/private-episode",
        token: "top-secret",
        url: "https://www.crunchyroll.com/watch/ABC123?room=secret&lang=en#private",
        driftSeconds: 1.25,
      },
    });

    const entries = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const details = entries.at(-1).details;

    assert.equal(details.username, "[redacted]");
    assert.equal(details.token, "[redacted]");
    assert.match(details.roomId, /^<roomId#[a-f0-9]{8}>$/);
    assert.match(details.socketId, /^<socketId#[a-f0-9]{8}>$/);
    assert.match(details.episodePath, /^<episodePath#[a-f0-9]{8}>$/);
    assert.equal(
      details.url,
      "https://www.crunchyroll.com/watch/ABC123?[room,lang]",
    );
    assert.equal(details.driftSeconds, 1.25);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
