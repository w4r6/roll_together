import { randomBytes } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";

import {
  MAX_VIDEO_PROGRESS_SECONDS,
  normalizeUsername,
  parseJoinRequest,
  parsePlaybackUpdate,
  type ClientToServerEvents,
  type JoinRequest,
  type PlaybackState,
  type PlaybackUpdate,
  type ProtocolError,
  type RoomSnapshot,
  type ServerToClientEvents,
} from "@roll-together/protocol";
import express from "express";
import { Server as SocketServer } from "socket.io";

interface Room {
  state: PlaybackState;
  progress: number;
  updatedAtMs: number;
  revision: number;
  members: Map<string, string>;
}

interface SocketData {
  joinRequest: JoinRequest;
  roomId?: string;
  updateWindowStartedAtMs: number;
  updatesInWindow: number;
}

export interface ServerOptions {
  allowedOrigins?: ReadonlyArray<string | RegExp>;
  maxConnections?: number;
  maxUpdatesPerSecond?: number;
  now?: () => number;
  generateRoomId?: () => string;
}

export interface RollTogetherServer {
  httpServer: HttpServer;
  io: SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >;
  rooms: InMemoryRoomStore;
  listen: (port?: number) => Promise<number>;
  close: () => Promise<void>;
}

const DEFAULT_MAX_CONNECTIONS = 2_000;
const DEFAULT_MAX_UPDATES_PER_SECOND = 30;
const CHROME_EXTENSION_ORIGIN =
  "chrome-extension://opfkhpijmigdkjafeenfgbndokfphamh";

export class InMemoryRoomStore {
  readonly #rooms = new Map<string, Room>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generateRoomId: () => string = createRoomId,
  ) {}

  get size(): number {
    return this.#rooms.size;
  }

  join(request: JoinRequest, socketId: string): RoomSnapshot {
    const roomId = request.roomId ?? this.#createUniqueRoomId();
    let room = this.#rooms.get(roomId);

    if (!room) {
      room = {
        state: request.state,
        progress: request.progress,
        updatedAtMs: this.now(),
        revision: 0,
        members: new Map<string, string>(),
      };
      this.#rooms.set(roomId, room);
    } else {
      room.revision += 1;
    }

    room.members.set(socketId, request.username);
    return this.#snapshot(roomId, room);
  }

  update(roomId: string, update: PlaybackUpdate): RoomSnapshot | null {
    const room = this.#rooms.get(roomId);
    if (!room) return null;

    room.state = update.state;
    room.progress = update.progress;
    room.updatedAtMs = this.now();
    room.revision += 1;
    return this.#snapshot(roomId, room);
  }

  rename(
    roomId: string,
    socketId: string,
    username: string,
  ): RoomSnapshot | null {
    const room = this.#rooms.get(roomId);
    if (!room || !room.members.has(socketId)) return null;
    if (room.members.get(socketId) === username)
      return this.#snapshot(roomId, room);

    room.members.set(socketId, username);
    room.revision += 1;
    return this.#snapshot(roomId, room);
  }

  leave(roomId: string, socketId: string): RoomSnapshot | null {
    const room = this.#rooms.get(roomId);
    if (!room || !room.members.delete(socketId)) return null;

    if (room.members.size === 0) {
      this.#rooms.delete(roomId);
      return null;
    }

    room.revision += 1;
    return this.#snapshot(roomId, room);
  }

  userCount(roomId: string): number {
    return this.#rooms.get(roomId)?.members.size ?? 0;
  }

  #createUniqueRoomId(): string {
    let roomId = this.generateRoomId();
    while (this.#rooms.has(roomId)) roomId = this.generateRoomId();
    return roomId;
  }

  #snapshot(roomId: string, room: Room): RoomSnapshot {
    const elapsedSeconds =
      room.state === "playing" ? (this.now() - room.updatedAtMs) / 1_000 : 0;
    return {
      roomId,
      state: room.state,
      progress: Math.min(
        room.progress + Math.max(0, elapsedSeconds),
        MAX_VIDEO_PROGRESS_SECONDS,
      ),
      revision: room.revision,
      members: Array.from(room.members, ([id, username]) => ({ id, username })),
    };
  }
}

export function createRollTogetherServer(
  options: ServerOptions = {},
): RollTogetherServer {
  const app = express();
  const httpServer = createHttpServer(app);
  const rooms = new InMemoryRoomStore(options.now, options.generateRoomId);
  const allowedOrigins =
    options.allowedOrigins ?? allowedOriginsFromEnvironment();
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxUpdatesPerSecond =
    options.maxUpdatesPerSecond ?? DEFAULT_MAX_UPDATES_PER_SECOND;

  const originAllowed = (origin: string | undefined): boolean =>
    origin === undefined ||
    allowedOrigins.some((candidate) =>
      typeof candidate === "string"
        ? candidate === origin
        : candidate.test(origin),
    );

  const io = new SocketServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    transports: ["websocket"],
    serveClient: false,
    maxHttpBufferSize: 4_096,
    perMessageDeflate: false,
    cors: {
      credentials: false,
      origin(origin, callback) {
        const allowed = originAllowed(origin);
        callback(allowed ? null : new Error("Origin is not allowed"), allowed);
      },
    },
    allowRequest(request, callback) {
      callback(null, originAllowed(request.headers.origin));
    },
  });

  app.get("/", (_request, response) => {
    response.status(200).json({ name: "roll-together-backend", status: "ok" });
  });

  app.get("/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      connections: io.engine.clientsCount,
      rooms: rooms.size,
    });
  });

  io.use((socket, next) => {
    if (io.engine.clientsCount > maxConnections) {
      next(new Error("server_full"));
      return;
    }

    const joinRequest = parseJoinRequest(socket.handshake.auth);
    if (!joinRequest) {
      next(new Error("invalid_request"));
      return;
    }

    socket.data.joinRequest = joinRequest;
    socket.data.updateWindowStartedAtMs = Date.now();
    socket.data.updatesInWindow = 0;
    next();
  });

  io.on("connection", (socket) => {
    const snapshot = rooms.join(socket.data.joinRequest, socket.id);
    socket.data.roomId = snapshot.roomId;
    socket.join(snapshot.roomId);
    socket.emit("room:joined", snapshot);
    socket.to(snapshot.roomId).emit("room:updated", snapshot);

    console.info(
      JSON.stringify({
        event: "room_joined",
        roomUsers: rooms.userCount(snapshot.roomId),
      }),
    );

    socket.on("playback:update", (value: PlaybackUpdate) => {
      if (!withinRateLimit(socket.data, maxUpdatesPerSecond)) {
        const error: ProtocolError = {
          code: "rate_limited",
          message: "Too many playback updates",
        };
        socket.emit("room:error", error);
        return;
      }

      const update = parsePlaybackUpdate(value);
      const roomId = socket.data.roomId;
      if (!update || !roomId) {
        const error: ProtocolError = {
          code: "invalid_request",
          message: "Invalid playback update",
        };
        socket.emit("room:error", error);
        return;
      }

      const nextSnapshot = rooms.update(roomId, update);
      if (nextSnapshot) io.to(roomId).emit("room:updated", nextSnapshot);
    });

    socket.on("profile:update", (value: string) => {
      const username = normalizeUsername(value);
      const roomId = socket.data.roomId;
      if (!username || !roomId) {
        const error: ProtocolError = {
          code: "invalid_request",
          message: "Invalid username",
        };
        socket.emit("room:error", error);
        return;
      }

      const nextSnapshot = rooms.rename(roomId, socket.id, username);
      if (nextSnapshot) io.to(roomId).emit("room:updated", nextSnapshot);
    });

    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (!roomId) return;
      const nextSnapshot = rooms.leave(roomId, socket.id);
      if (nextSnapshot) io.to(roomId).emit("room:updated", nextSnapshot);
      console.info(
        JSON.stringify({
          event: "room_left",
          roomUsers: rooms.userCount(roomId),
        }),
      );
    });
  });

  return {
    httpServer,
    io,
    rooms,
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, () => {
          httpServer.off("error", reject);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("Server did not bind to a TCP port"));
            return;
          }
          resolve(address.port);
        });
      });
    },
    close() {
      return new Promise((resolve) => io.close(() => resolve()));
    },
  };
}

function withinRateLimit(
  data: SocketData,
  maxUpdatesPerSecond: number,
): boolean {
  const now = Date.now();
  if (now - data.updateWindowStartedAtMs >= 1_000) {
    data.updateWindowStartedAtMs = now;
    data.updatesInWindow = 0;
  }
  data.updatesInWindow += 1;
  return data.updatesInWindow <= maxUpdatesPerSecond;
}

function createRoomId(): string {
  return randomBytes(15).toString("base64url");
}

function allowedOriginsFromEnvironment(): ReadonlyArray<string | RegExp> {
  const configured = process.env.ROLL_TOGETHER_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const origins: Array<string | RegExp> = configured?.length
    ? configured
    : [CHROME_EXTENSION_ORIGIN, /^moz-extension:\/\/[a-z0-9-]+$/i];

  if (process.env.NODE_ENV !== "production") {
    origins.push(/^chrome-extension:\/\/[a-p]{32}$/);
    origins.push(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  }
  return origins;
}

async function startProductionServer(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }

  const server = createRollTogetherServer();
  const boundPort = await server.listen(port);
  console.info(JSON.stringify({ event: "server_started", port: boundPort }));

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(JSON.stringify({ event: "server_stopping", signal }));
    await server.close();
    process.exitCode = 0;
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
  void startProductionServer().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: "server_failed",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    process.exitCode = 1;
  });
}
