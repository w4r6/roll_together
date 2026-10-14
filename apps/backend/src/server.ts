import { Server as SocketServer, Socket } from "socket.io";
import express from "express";
import { createServer } from "http";
import { randomInt } from "crypto";

enum VideoState {
  PLAYING = "playing",
  PAUSED = "paused",
}

interface Room {
  state: VideoState;
  progress: {
    value: number;
    lastUpdate: Date;
  };
  users: Set<string>;
}

interface ServerToClientEvents {
  update: (
    senderId: string,
    state: VideoState,
    progress: number,
    userCount: number
  ) => void;
  join: (
    roomId: string,
    state: VideoState,
    progress: number,
    userCount: number
  ) => void;
}

interface ClientToServerEvents {
  update: (state: VideoState, progress: number) => void;
  sync: (ack: (state: VideoState, progress: number) => void) => void;
}

const PORT: number = parseInt(process.env.PORT || "3000");
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOM_ID_PATTERN = /^[A-Za-z0-9]{16,64}$/;
const MAX_PROGRESS = 1e6;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_EVENTS = 10;
const SHUTDOWN_TIMEOUT_MS = 10000;

const rooms = new Map<string, Room>();

const debug = (...args: unknown[]) => {
  if (!IS_PRODUCTION) {
    console.log(...args);
  }
};

// Prefix socket.io room names so a room id can never collide with a socket id
const channel = (roomId: string) => `room:${roomId}`;

const joinRoom = (roomId: string, socket: Socket, initialProgress: number) => {
  let room = rooms.get(roomId);
  if (room === undefined) {
    room = {
      state: VideoState.PAUSED,
      progress: { value: initialProgress, lastUpdate: new Date() },
      users: new Set(),
    };
    rooms.set(roomId, room);
  } else {
    // Freeze the extrapolated progress before pausing so joiners don't rewind
    room.progress.value = getVideoProgress(roomId);
    room.progress.lastUpdate = new Date();
  }
  socket.join(channel(roomId));
  room.state = VideoState.PAUSED;
  room.users.add(socket.id);
};

const leaveRoom = (roomId: string, socket: Socket) => {
  // It will automatically leave the room for socketIO
  const room = rooms.get(roomId);
  if (room === undefined) {
    return;
  }
  room.users.delete(socket.id);
  if (room.users.size === 0) {
    rooms.delete(roomId);
  }
};

const getUserCount = (roomId: string) => {
  return rooms.get(roomId)?.users.size ?? 0;
};

const updateVideoState = (roomId: string, state: VideoState) => {
  const room = rooms.get(roomId);
  if (room !== undefined) {
    room.state = state;
  }
};

const getVideoState = (roomId: string) => {
  return rooms.get(roomId)?.state ?? VideoState.PAUSED;
};

const updateRoomProgress = (roomId: string, progress: number) => {
  const room = rooms.get(roomId);
  if (room !== undefined) {
    room.progress.lastUpdate = new Date();
    room.progress.value = progress;
  }
};

const getVideoProgress = (roomId: string) => {
  const room = rooms.get(roomId);
  if (room === undefined) {
    return 0;
  }
  const additionalProgress =
    room.state === VideoState.PLAYING
      ? (new Date().getTime() - room.progress.lastUpdate.getTime()) / 1000
      : 0;

  return room.progress.value + additionalProgress;
};

const app = express();

app.get("/", (_req, res) => {
  res.status(200).json({ name: "roll-together-backend", status: "ok" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

const httpServer = createServer(app);
const io = new SocketServer<ClientToServerEvents, ServerToClientEvents>(
  httpServer,
  {
    cors: {
      origin: true,
    },
    maxHttpBufferSize: 1e4,
  }
);

io.on("connection", (socket) => {
  const roomId = parseRoomId(first(socket.handshake.query["room"])) || genId();
  const initialProgress = parseProgress(
    first(socket.handshake.query["videoProgress"])
  );
  const allowEvent = createRateLimiter();

  debug("Client connected");

  socket.on("disconnect", () => {
    debug("Client disconnected");
    leaveRoom(roomId, socket);
  });

  socket.on("update", (videoState, videoProgress) => {
    if (!allowEvent()) {
      return;
    }
    if (!isVideoState(videoState) || !isValidProgress(videoProgress)) {
      return;
    }
    if (!rooms.has(roomId)) {
      return;
    }

    updateVideoState(roomId, videoState);
    updateRoomProgress(roomId, videoProgress);

    socket
      .to(channel(roomId))
      .emit(
        "update",
        socket.id,
        getVideoState(roomId),
        getVideoProgress(roomId),
        getUserCount(roomId)
      );
  });

  socket.on("sync", (ack) => {
    if (!allowEvent()) {
      return;
    }
    if (typeof ack !== "function" || !rooms.has(roomId)) {
      return;
    }
    ack(getVideoState(roomId), getVideoProgress(roomId));
  });

  joinRoom(roomId, socket, initialProgress);

  const userCount = getUserCount(roomId);
  const progress = getVideoProgress(roomId);
  const videoState = getVideoState(roomId);

  socket.emit("join", roomId, videoState, progress, userCount);
  socket
    .to(channel(roomId))
    .emit("update", socket.id, videoState, progress, userCount);
});

function first<T>(value: T | T[]) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  return value;
}

function parseRoomId(value: unknown) {
  return typeof value === "string" && ROOM_ID_PATTERN.test(value)
    ? value
    : null;
}

function parseProgress(value: unknown) {
  const progress = typeof value === "string" ? parseFloat(value) : NaN;
  return isValidProgress(progress) ? progress : 0;
}

function isVideoState(value: unknown): value is VideoState {
  return value === VideoState.PLAYING || value === VideoState.PAUSED;
}

function isValidProgress(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_PROGRESS
  );
}

function createRateLimiter() {
  let windowStart = Date.now();
  let count = 0;

  return () => {
    const now = Date.now();
    if (now - windowStart >= RATE_LIMIT_WINDOW_MS) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= RATE_LIMIT_MAX_EVENTS;
  };
}

function genId() {
  const length = 20;
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

  const id = Array.from(Array(length))
    .map((_) => characters[randomInt(characters.length)])
    .join("");
  return id;
}

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down`);
  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // io.close() also closes the underlying http server
  io.close(() => {
    process.exit(0);
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
