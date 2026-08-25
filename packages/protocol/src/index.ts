export const PROTOCOL_VERSION = 2 as const;
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
export const MAX_VIDEO_PROGRESS_SECONDS = 7 * 24 * 60 * 60;
export const MAX_USERNAME_LENGTH = 24;

export type PlaybackState = "playing" | "paused";

export interface PlaybackUpdate {
  state: PlaybackState;
  progress: number;
}

export interface JoinRequest extends PlaybackUpdate {
  protocolVersion: typeof PROTOCOL_VERSION;
  username: string;
  roomId?: string;
}

export interface RoomMember {
  id: string;
  username: string;
}

export interface RoomSnapshot extends PlaybackUpdate {
  roomId: string;
  revision: number;
  members: RoomMember[];
}

export interface ProtocolError {
  code: "invalid_request" | "rate_limited" | "server_full";
  message: string;
}

export interface ServerToClientEvents {
  "room:joined": (snapshot: RoomSnapshot) => void;
  "room:updated": (snapshot: RoomSnapshot) => void;
  "room:error": (error: ProtocolError) => void;
}

export interface ClientToServerEvents {
  "playback:update": (update: PlaybackUpdate) => void;
  "profile:update": (username: string) => void;
}

export function isPlaybackState(value: unknown): value is PlaybackState {
  return value === "playing" || value === "paused";
}

export function isValidProgress(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_VIDEO_PROGRESS_SECONDS
  );
}

export function isValidRoomId(value: unknown): value is string {
  return typeof value === "string" && ROOM_ID_PATTERN.test(value);
}

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/\s+/g, " ");
  const hasControlCharacter = Array.from(username).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (
    username.length === 0 ||
    username.length > MAX_USERNAME_LENGTH ||
    hasControlCharacter
  ) {
    return null;
  }
  return username;
}

export function parsePlaybackUpdate(value: unknown): PlaybackUpdate | null {
  if (!isRecord(value)) return null;
  if (!isPlaybackState(value.state) || !isValidProgress(value.progress)) {
    return null;
  }
  return { state: value.state, progress: value.progress };
}

export function parseJoinRequest(value: unknown): JoinRequest | null {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION) {
    return null;
  }

  const playback = parsePlaybackUpdate(value);
  if (!playback) return null;
  const username = normalizeUsername(value.username);
  if (!username) return null;

  if (value.roomId !== undefined && !isValidRoomId(value.roomId)) {
    return null;
  }

  return value.roomId === undefined
    ? { ...playback, protocolVersion: PROTOCOL_VERSION, username }
    : {
        ...playback,
        protocolVersion: PROTOCOL_VERSION,
        username,
        roomId: value.roomId,
      };
}

export function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.members) || value.members.length === 0) return false;
  const memberIds = new Set<string>();
  for (const member of value.members) {
    if (!isRoomMember(member) || memberIds.has(member.id)) return false;
    memberIds.add(member.id);
  }
  return (
    isValidRoomId(value.roomId) &&
    Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    parsePlaybackUpdate(value) !== null
  );
}

function isRoomMember(value: unknown): value is RoomMember {
  if (!isRecord(value)) return false;
  const username = normalizeUsername(value.username);
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    username !== null &&
    username === value.username
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
