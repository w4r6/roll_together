import type { PlaybackUpdate, RoomSnapshot } from "@roll-together/protocol";

export const PortName = {
  CONTENT: "content",
  POPUP: "popup",
} as const;

export type ConnectionStatus =
  | { state: "disconnected" }
  | { state: "connecting" }
  | {
      state: "connected";
      roomId: string;
      members: Array<{ username: string; isSelf: boolean }>;
    }
  | { state: "error"; message: string };

export type ContentToBackgroundMessage =
  | { type: "content:ready"; playback: PlaybackUpdate; roomId?: string }
  | { type: "room:connect"; playback: PlaybackUpdate; roomId?: string }
  | { type: "playback:update"; playback: PlaybackUpdate };

export type BackgroundToContentMessage =
  | { type: "room:connect-request"; roomId?: string }
  | { type: "room:snapshot"; snapshot: RoomSnapshot }
  | { type: "room:member-joined"; username: string }
  | { type: "room:disconnected" }
  | { type: "room:error"; message: string };

export type PopupToBackgroundMessage =
  | { type: "popup:status"; tabId: number }
  | { type: "popup:create"; tabId: number }
  | { type: "popup:disconnect"; tabId: number };

export type BackgroundToPopupMessage = {
  type: "popup:status";
  status: ConnectionStatus;
};

export interface StorageData {
  username?: string;
}
