const test = require("node:test");
const assert = require("node:assert/strict");

const { io: createClient } = require("socket.io-client");
const { PROTOCOL_VERSION } = require("../../../packages/protocol/dist");
const { createRollTogetherServer } = require("../build/server");

const sockets = new Set();
let server;
let url;

test.beforeEach(async () => {
  server = createRollTogetherServer({ allowedOrigins: [] });
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

function connect(auth) {
  const socket = createClient(url, {
    auth: { protocolVersion: PROTOCOL_VERSION, username: "Host", ...auth },
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
