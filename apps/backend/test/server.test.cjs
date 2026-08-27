const test = require("node:test");
const assert = require("node:assert/strict");

const { io: createClient } = require("socket.io-client");
const {
  PROTOCOL_VERSION,
  V2_SOCKET_PATH,
} = require("../../../packages/protocol/dist");
const { createRollTogetherServer } = require("../build/server");

const sockets = new Set();
let server;
let url;
let debugEntries;

test.beforeEach(async () => {
  debugEntries = [];
  server = createRollTogetherServer({
    allowedOrigins: [],
    debugLog: { record: (entry) => debugEntries.push(entry) },
  });
  const port = await server.listen(0);
  url = `http://127.0.0.1:${port}`;
});

test.afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  sockets.clear();
  await server.close();
});

test("keeps existing room state when another viewer joins", async () => {
  const host = connect({ state: "playing", progress: 42 });
  const hostSnapshot = await once(host, "room:joined");
  const membershipUpdate = once(host, "room:updated");

  const guest = connect({
    roomId: hostSnapshot.roomId,
    state: "paused",
    progress: 0,
    username: "Guest",
  });
  const guestSnapshot = await once(guest, "room:joined");
  const hostMembership = await membershipUpdate;

  assert.equal(guestSnapshot.roomId, hostSnapshot.roomId);
  assert.equal(guestSnapshot.state, "playing");
  assert.ok(guestSnapshot.progress >= 42);
  assert.deepEqual(
    guestSnapshot.members.map((member) => member.username),
    ["Host", "Guest"],
  );
  assert.equal(hostMembership.members.length, 2);
});

test("broadcasts validated playback updates", async () => {
  const host = connect({ state: "paused", progress: 0 });
  const hostSnapshot = await once(host, "room:joined");
  const guest = connect({
    roomId: hostSnapshot.roomId,
    state: "paused",
    progress: 0,
    username: "Guest",
  });
  await once(guest, "room:joined");

  const updatePromise = once(guest, "room:updated");
  host.emit("playback:update", { state: "playing", progress: 15 });
  const update = await updatePromise;

  assert.equal(update.state, "playing");
  assert.equal(update.revision, 2);
  assert.ok(update.progress >= 15);
});

test("broadcasts episode changes and resets playback", async () => {
  const host = connect({
    state: "playing",
    progress: 1_200,
    episodePath: "/watch/GN7U11111/episode-one",
  });
  const hostSnapshot = await once(host, "room:joined");
  const guest = connect({
    roomId: hostSnapshot.roomId,
    state: "paused",
    progress: 0,
    username: "Guest",
    episodePath: "/watch/GN7U11111/episode-one",
  });
  await once(guest, "room:joined");

  const updatePromise = once(guest, "room:updated");
  host.emit("episode:update", "/watch/GN7U22222/episode-two?lang=en");
  const update = await updatePromise;

  assert.equal(update.episodePath, "/watch/GN7U22222/episode-two?lang=en");
  assert.equal(update.state, "paused");
  assert.equal(update.progress, 0);
  assert.equal(update.revision, 2);
});

test("rejects episode updates outside Crunchyroll watch routes", async () => {
  const host = connect({ state: "paused", progress: 0 });
  await once(host, "room:joined");

  const errorPromise = once(host, "room:error");
  host.emit("episode:update", "https://example.com/watch/GN7U22222");
  const error = await errorPromise;

  assert.equal(error.code, "invalid_request");
});

test("broadcasts username changes and departures", async () => {
  const host = connect({ state: "paused", progress: 0 });
  const hostSnapshot = await once(host, "room:joined");
  const joined = once(host, "room:updated");
  const guest = connect({
    roomId: hostSnapshot.roomId,
    state: "paused",
    progress: 0,
    username: "Guest",
  });
  await once(guest, "room:joined");
  await joined;

  const renamed = once(host, "room:updated");
  guest.emit("profile:update", "New Name");
  assert.deepEqual(
    (await renamed).members.map((member) => member.username),
    ["Host", "New Name"],
  );

  const departed = once(host, "room:updated");
  guest.disconnect();
  assert.deepEqual(
    (await departed).members.map((member) => member.username),
    ["Host"],
  );
});

test("rejects malformed room identifiers without crashing", async () => {
  const client = connect({
    roomId: "__proto__",
    state: "paused",
    progress: 0,
    username: "Guest",
  });
  const error = await once(client, "connect_error");
  assert.equal(error.message, "invalid_request");
  assert.equal(server.rooms.size, 0);
});

test("serves extension v1 on the unchanged default Socket.IO endpoint", async () => {
  const host = connectLegacy({ videoProgress: "12", videoState: "playing" });
  const [roomId, state, progress, userCount] = await onceArgs(host, "join");

  assert.match(roomId, /^[A-Za-z0-9]{20}$/);
  assert.equal(state, "paused");
  assert.equal(progress, 12);
  assert.equal(userCount, 1);

  const hostMembershipUpdate = onceArgs(host, "update");
  const guest = connectLegacy({
    room: roomId,
    videoProgress: "0",
    videoState: "paused",
  });
  const [, , , guestCount] = await onceArgs(guest, "join");
  const [, , , hostCount] = await hostMembershipUpdate;
  assert.equal(guestCount, 2);
  assert.equal(hostCount, 2);

  const guestPlaybackUpdate = onceArgs(guest, "update");
  host.emit("update", "playing", 25);
  const [senderId, nextState, nextProgress, nextCount] =
    await guestPlaybackUpdate;
  assert.equal(senderId, host.id);
  assert.equal(nextState, "playing");
  assert.ok(nextProgress >= 25);
  assert.equal(nextCount, 2);
});

test("keeps v1 and v2 rooms isolated even when their IDs match", async () => {
  const sharedRoomId = "ABCDEFGHIJKLMNOPQRST";
  const legacy = connectLegacy({
    room: sharedRoomId,
    videoProgress: "5",
    videoState: "paused",
  });
  const [, , , legacyCount] = await onceArgs(legacy, "join");

  const modern = connect({
    roomId: sharedRoomId,
    state: "paused",
    progress: 50,
  });
  const modernSnapshot = await once(modern, "room:joined");

  assert.equal(legacyCount, 1);
  assert.equal(modernSnapshot.members.length, 1);
  assert.equal(server.legacy.rooms.size, 1);
  assert.equal(server.rooms.size, 1);

  const unexpectedModernUpdate = expectNoEvent(modern, "room:updated");
  legacy.emit("update", "playing", 30);
  await unexpectedModernUpdate;
});

test("reports v1 and v2 usage separately for migration monitoring", async () => {
  const legacy = connectLegacy({
    videoProgress: "0",
    videoState: "paused",
  });
  await onceArgs(legacy, "join");
  const modern = connect({ state: "paused", progress: 0 });
  await once(modern, "room:joined");

  const response = await fetch(`${url}/health`);
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.equal(health.connections, 2);
  assert.equal(health.rooms, 2);
  assert.deepEqual(health.connectionsByProtocol, { v1: 1, v2: 1 });
  assert.deepEqual(health.roomsByProtocol, { v1: 1, v2: 1 });
});

test("accepts bounded development diagnostic batches", async () => {
  const response = await fetch(`${url}/__debug/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entries: [
        {
          timestamp: "2026-08-27T18:00:00.000Z",
          level: "warn",
          source: "content_script",
          contextId: "test-context",
          event: "playback_seek_failed",
          details: { driftSeconds: 2.5 },
        },
      ],
    }),
  });

  assert.equal(response.status, 204);
  assert.ok(
    debugEntries.some(
      (entry) =>
        entry.source === "content_script" &&
        entry.event === "playback_seek_failed",
    ),
  );
});

test("rejects malformed development diagnostic batches", async () => {
  const response = await fetch(`${url}/__debug/log`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entries: [{ source: "missing required fields" }] }),
  });

  assert.equal(response.status, 400);
  assert.ok(
    debugEntries.some(
      (entry) => entry.event === "extension_debug_batch_rejected",
    ),
  );
});

function connect(auth) {
  const socket = createClient(url, {
    path: V2_SOCKET_PATH,
    auth: { protocolVersion: PROTOCOL_VERSION, username: "Host", ...auth },
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  sockets.add(socket);
  return socket;
}

function connectLegacy(query) {
  const socket = createClient(url, {
    query,
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
  });
  sockets.add(socket);
  return socket;
}

function once(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      2_000,
    );
    socket.once(event, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

function onceArgs(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${event}`)),
      2_000,
    );
    socket.once(event, (...values) => {
      clearTimeout(timeout);
      resolve(values);
    });
  });
}

function expectNoEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, 150);
    const onEvent = () => {
      clearTimeout(timeout);
      reject(new Error(`Unexpected ${event}`));
    };
    socket.once(event, onEvent);
  });
}
