const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_VIDEO_PROGRESS_SECONDS,
  PROTOCOL_VERSION,
  isRoomSnapshot,
  normalizeUsername,
  parseEpisodePath,
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
      episodePath: "/watch/GN7U12345/example-episode?lang=en",
    }),
    {
      protocolVersion: PROTOCOL_VERSION,
      roomId: "abcdefghijklmnopqrst",
      state: "playing",
      progress: 12.5,
      username: "Amber Fox",
      episodePath: "/watch/GN7U12345/example-episode?lang=en",
    },
  );
  assert.deepEqual(parsePlaybackUpdate({ state: "paused", progress: 0 }), {
    state: "paused",
    progress: 0,
  });
  assert.equal(normalizeUsername("  Quiet   Panda  "), "Quiet Panda");
  assert.equal(
    parseEpisodePath("/en-gb/watch/GN7U12345/example-episode"),
    "/en-gb/watch/GN7U12345/example-episode",
  );
  assert.equal(
    isRoomSnapshot({
      roomId: "abcdefghijklmnopqrst",
      state: "paused",
      progress: 0,
      revision: 1,
      members: [{ id: "socket-id", username: "Quiet Panda" }],
      episodePath: "/watch/GN7U12345/example-episode",
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
  assert.equal(parseEpisodePath("https://example.com/watch/GN7U12345"), null);
  assert.equal(parseEpisodePath("/series/GN7U12345/example-series"), null);
  assert.equal(parseEpisodePath("/not-a-locale/watch/GN7U12345"), null);
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
