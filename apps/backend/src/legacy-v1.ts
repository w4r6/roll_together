import { randomInt } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import {
  MAX_VIDEO_PROGRESS_SECONDS,
  isPlaybackState,
  isValidProgress,
  type PlaybackState,
} from "@roll-together/protocol";
import { Server as SocketServer } from "socket.io";

interface LegacyRoom {
  state: PlaybackState;
  progress: number;
  updatedAtMs: number;
  socketIds: Set<string>;
}

interface LegacyClientToServerEvents {
  update: (state: PlaybackState, progress: number) => void;
}

interface LegacyServerToClientEvents {
  join: (
    roomId: string,
    state: PlaybackState,
    progress: number,
    userCount: number,
  ) => void;
  update: (
    senderId: string,
    state: PlaybackState,
    progress: number,
    userCount: number,
  ) => void;
}

interface LegacySocketData {
  initialProgress: number;
  roomId: string;
}

export interface LegacyV1Server {
  io: SocketServer<
    LegacyClientToServerEvents,
    LegacyServerToClientEvents,
    Record<string, never>,
    LegacySocketData
  >;
  rooms: LegacyV1RoomStore;
}

interface LegacyV1ServerOptions {
  originAllowed: (origin: string | undefined) => boolean;
  now?: () => number;
  generateRoomId?: () => string;
}

// LEGACY_V1_COMPAT: This entire file is the isolated extension v1 backend.
// Once v1 traffic has ended, delete this file and the marked mount/health
// references in server.ts. The v2 endpoint does not depend on this code.
export class LegacyV1RoomStore {
  readonly #rooms = new Map<string, LegacyRoom>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly generateRoomId: () => string = createLegacyRoomId,
  ) {}

  get size(): number {
    return this.#rooms.size;
  }

  userCount(roomId: string): number {
    return this.#rooms.get(roomId)?.socketIds.size ?? 0;
  }

  join(
    requestedRoomId: string | undefined,
    socketId: string,
    progress: number,
  ) {
    const roomId = requestedRoomId ?? this.#createUniqueRoomId();
    let room = this.#rooms.get(roomId);
    if (!room) {
      room = {
        state: "paused",
        progress,
        updatedAtMs: this.now(),
        socketIds: new Set(),
      };
      this.#rooms.set(roomId, room);
    }

    // Extension v1's backend paused a room whenever somebody joined. This is
    // intentionally preserved here so the temporary endpoint behaves exactly
    // like the backend already installed v1 clients expect.
    room.state = "paused";
    room.socketIds.add(socketId);
    return this.#snapshot(roomId, room);
  }

  update(roomId: string, state: PlaybackState, progress: number) {
    const room = this.#rooms.get(roomId);
    if (!room) return null;
    room.state = state;
    room.progress = progress;
    room.updatedAtMs = this.now();
    return this.#snapshot(roomId, room);
  }

  leave(roomId: string, socketId: string): void {
    const room = this.#rooms.get(roomId);
    if (!room) return;
    room.socketIds.delete(socketId);
    if (room.socketIds.size === 0) this.#rooms.delete(roomId);
  }

  #snapshot(roomId: string, room: LegacyRoom) {
    const elapsedSeconds =
      room.state === "playing" ? (this.now() - room.updatedAtMs) / 1_000 : 0;
    return {
      roomId,
      state: room.state,
      progress: Math.min(
        room.progress + Math.max(0, elapsedSeconds),
        MAX_VIDEO_PROGRESS_SECONDS,
      ),
      userCount: room.socketIds.size,
    };
  }

  #createUniqueRoomId(): string {
    let roomId = this.generateRoomId();
    while (this.#rooms.has(roomId)) roomId = this.generateRoomId();
    return roomId;
  }
}

export function attachLegacyV1Server(
  httpServer: HttpServer,
  options: LegacyV1ServerOptions,
): LegacyV1Server {
  const rooms = new LegacyV1RoomStore(options.now, options.generateRoomId);
  const io = new SocketServer<
    LegacyClientToServerEvents,
    LegacyServerToClientEvents,
    Record<string, never>,
    LegacySocketData
  >(httpServer, {
    // Do not change this path: released v1 extensions use Socket.IO's default.
    path: "/socket.io",
    transports: ["websocket"],
    serveClient: false,
    maxHttpBufferSize: 4_096,
    perMessageDeflate: false,
    cors: {
      credentials: false,
      origin(origin, callback) {
        const allowed = options.originAllowed(origin);
        callback(allowed ? null : new Error("Origin is not allowed"), allowed);
      },
    },
    allowRequest(request, callback) {
      callback(null, options.originAllowed(request.headers.origin));
    },
  });

  io.use((socket, next) => {
    const roomId = firstQueryValue(socket.handshake.query.room) || undefined;
    const progressValue = firstQueryValue(socket.handshake.query.videoProgress);
    // The original v1 backend defaulted a missing progress value to zero.
    const initialProgress = Number.parseInt(progressValue ?? "0", 10);
    if (
      (roomId !== undefined && !isLegacyRoomId(roomId)) ||
      !isValidProgress(initialProgress)
    ) {
      next(new Error("invalid_request"));
      return;
    }

    socket.data.roomId = roomId ?? "";
    socket.data.initialProgress = initialProgress;
    next();
  });

  io.on("connection", (socket) => {
    const snapshot = rooms.join(
      socket.data.roomId || undefined,
      socket.id,
      socket.data.initialProgress,
    );
    socket.data.roomId = snapshot.roomId;
    socket.join(snapshot.roomId);
    socket.emit(
      "join",
      snapshot.roomId,
      snapshot.state,
      snapshot.progress,
      snapshot.userCount,
    );
    socket
      .to(snapshot.roomId)
      .emit(
        "update",
        socket.id,
        snapshot.state,
        snapshot.progress,
        snapshot.userCount,
      );

    console.info(
      JSON.stringify({
        event: "room_joined",
        protocolVersion: 1,
        roomUsers: snapshot.userCount,
      }),
    );

    socket.on("update", (state: PlaybackState, progress: number) => {
      if (!isPlaybackState(state) || !isValidProgress(progress)) return;
      const nextSnapshot = rooms.update(socket.data.roomId, state, progress);
      if (!nextSnapshot) return;
      socket
        .to(socket.data.roomId)
        .emit(
          "update",
          socket.id,
          nextSnapshot.state,
          nextSnapshot.progress,
          nextSnapshot.userCount,
        );
    });

    socket.on("disconnect", () => {
      rooms.leave(socket.data.roomId, socket.id);
      console.info(
        JSON.stringify({
          event: "room_left",
          protocolVersion: 1,
          roomUsers: rooms.userCount(socket.data.roomId),
        }),
      );
    });
  });

  return { io, rooms };
}

function firstQueryValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isLegacyRoomId(value: string): boolean {
  return /^[A-Za-z0-9]{20}$/.test(value);
}

function createLegacyRoomId(): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length: 20 },
    () => characters[randomInt(characters.length)],
  ).join("");
}
