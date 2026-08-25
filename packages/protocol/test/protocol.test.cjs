const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_VIDEO_PROGRESS_SECONDS,
  PROTOCOL_VERSION,
  isRoomSnapshot,
  normalizeUsername,
  parseJoinRequest,
  parsePlaybackUpdate,
} = require("../dist");

test("accepts valid join and playback payloads", () => {
  assert.deepEqual(
    parseJoinRequest({
      protocolVersion: PROTOCOL_VERSION,
      roomId: "abcdefghijklmnopqrst",
      state: "playing",
      progress: 12.5,
      username: "  Amber   Fox  ",
    }),
    {
      protocolVersion: PROTOCOL_VERSION,
      roomId: "abcdefghijklmnopqrst",
      state: "playing",
      progress: 12.5,
      username: "Amber Fox",
    },
  );
  assert.deepEqual(parsePlaybackUpdate({ state: "paused", progress: 0 }), {
    state: "paused",
    progress: 0,
  });
  assert.equal(normalizeUsername("  Quiet   Panda  "), "Quiet Panda");
  assert.equal(
    isRoomSnapshot({
      roomId: "abcdefghijklmnopqrst",
      state: "paused",
      progress: 0,
      revision: 1,
      members: [{ id: "socket-id", username: "Quiet Panda" }],
    }),
    true,
  );
});

test("rejects malformed or unsafe payloads", () => {
  assert.equal(
    parseJoinRequest({
      protocolVersion: PROTOCOL_VERSION,
      roomId: "__proto__",
      state: "paused",
      progress: 0,
      username: "Guest",
    }),
    null,
  );
  assert.equal(normalizeUsername("   "), null);
  assert.equal(normalizeUsername("a".repeat(25)), null);
  assert.equal(
    isRoomSnapshot({
      roomId: "abcdefghijklmnopqrst",
      state: "paused",
      progress: 0,
      revision: 1,
      members: [],
    }),
    false,
  );
  assert.equal(parsePlaybackUpdate({ state: "buffering", progress: 0 }), null);
  assert.equal(
    parsePlaybackUpdate({ state: "playing", progress: Infinity }),
    null,
  );
  assert.equal(
    parsePlaybackUpdate({
      state: "playing",
      progress: MAX_VIDEO_PROGRESS_SECONDS + 1,
    }),
    null,
  );
});
