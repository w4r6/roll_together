import {
  PROTOCOL_VERSION,
  V2_SOCKET_PATH,
  isRoomSnapshot,
  normalizeUsername,
  type ClientToServerEvents,
  type JoinRequest,
  type PlaybackUpdate,
  type RoomSnapshot,
  type ServerToClientEvents,
} from "@roll-together/protocol";
import { io, type Socket } from "socket.io-client";

import { getActionApi } from "./extension-api";
import { getOrCreateUsername, log, updateActionIcon } from "./common";
import {
  PortName,
  type BackgroundToContentMessage,
  type BackgroundToPopupMessage,
  type ConnectionStatus,
  type ContentToBackgroundMessage,
  type PopupToBackgroundMessage,
} from "./types";

declare const process: { env: { SYNC_SERVER?: string } };

type SyncSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface TabSession {
  tabId: number;
  frameId: number;
  port: chrome.runtime.Port;
  socket?: SyncSocket;
  roomId?: string;
  lastSnapshot?: RoomSnapshot;
  latestRevision: number;
  connectionAttempt: number;
  status: ConnectionStatus;
}

const serverUrl = process.env.SYNC_SERVER;
if (!serverUrl) throw new Error("SYNC_SERVER is not configured");

const sessions = new Map<number, TabSession>();
const pendingDisconnects = new Map<number, ReturnType<typeof setTimeout>>();
let popupPort: chrome.runtime.Port | undefined;
let popupTabId: number | undefined;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PortName.POPUP) {
    connectPopup(port);
    return;
  }
  if (port.name === PortName.CONTENT) {
    connectContentScript(port);
    return;
  }
  log("Ignoring unknown port", port.name);
});

chrome.runtime.onInstalled.addListener(() => {
  getActionApi().disable();
  void getOrCreateUsername().catch((error: unknown) =>
    log("Could not initialize username", error),
  );
  void updateActionIcon().catch((error: unknown) =>
    log("Could not initialize action icon", error),
  );
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;

  const username = normalizeUsername(changes.username?.newValue);
  if (username) {
    for (const session of sessions.values()) {
      if (session.socket?.connected) {
        session.socket.emit("profile:update", username);
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => removeSession(tabId));

function connectPopup(port: chrome.runtime.Port): void {
  popupPort = port;
  port.onMessage.addListener((value: unknown) => {
    const message = value as PopupToBackgroundMessage;
    popupTabId = message.tabId;

    if (message.type === "popup:status") {
      sendPopupStatus(statusForTab(message.tabId));
      return;
    }
    if (message.type === "popup:create") {
      requestRoomConnection(message.tabId);
      return;
    }
    if (message.type === "popup:disconnect") {
      disconnectRoom(message.tabId);
    }
  });
  port.onDisconnect.addListener(() => {
    if (popupPort === port) {
      popupPort = undefined;
      popupTabId = undefined;
    }
  });
}

function connectContentScript(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    port.disconnect();
    return;
  }

  const pending = pendingDisconnects.get(tabId);
  if (pending) {
    clearTimeout(pending);
    pendingDisconnects.delete(tabId);
  }

  port.onMessage.addListener((value: unknown) => {
    handleContentMessage(tabId, port, value as ContentToBackgroundMessage);
  });
  port.onDisconnect.addListener(() => scheduleSessionRemoval(tabId, port));
}

function handleContentMessage(
  tabId: number,
  port: chrome.runtime.Port,
  message: ContentToBackgroundMessage,
): void {
  if (message.type === "content:ready") {
    const existing = sessions.get(tabId);
    const frameId = port.sender?.frameId ?? 0;
    const session: TabSession = existing
      ? { ...existing, port, frameId }
      : {
          tabId,
          frameId,
          port,
          latestRevision: -1,
          connectionAttempt: 0,
          status: { state: "disconnected" },
        };

    sessions.set(tabId, session);
    getActionApi().enable(tabId);

    if (session.lastSnapshot) {
      postToContent(session, {
        type: "room:snapshot",
        snapshot: session.lastSnapshot,
      });
    }

    if (message.roomId && message.roomId !== session.roomId) {
      void connectRoom(session, message.playback, message.roomId);
    }
    return;
  }

  const session = sessions.get(tabId);
  if (!session || session.port !== port) return;

  if (message.type === "room:connect") {
    void connectRoom(session, message.playback, message.roomId);
    return;
  }

  if (message.type === "playback:update" && session.socket?.connected) {
    session.socket.emit("playback:update", message.playback);
  }
}

function requestRoomConnection(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) {
    sendPopupStatus({
      state: "error",
      message: "No Crunchyroll video was found in this tab.",
    });
    return;
  }

  session.status = { state: "connecting" };
  sendPopupStatus(session.status);
  postToContent(session, { type: "room:connect-request" });
}

async function connectRoom(
  session: TabSession,
  playback: PlaybackUpdate,
  roomId?: string,
): Promise<void> {
  if (session.socket) disconnectSocket(session);
  const connectionAttempt = ++session.connectionAttempt;

  session.status = { state: "connecting" };
  updatePopupForSession(session);

  let username: string;
  try {
    username = await getOrCreateUsername();
  } catch (error: unknown) {
    if (session.connectionAttempt !== connectionAttempt) return;
    session.status = {
      state: "error",
      message: "Could not load your username.",
    };
    updatePopupForSession(session);
    log("Could not load username", error);
    return;
  }
  if (session.connectionAttempt !== connectionAttempt) return;

  const joinRequest: JoinRequest = roomId
    ? { ...playback, protocolVersion: PROTOCOL_VERSION, username, roomId }
    : { ...playback, protocolVersion: PROTOCOL_VERSION, username };

  const socket: SyncSocket = io(serverUrl, {
    // Extension v1 owns Socket.IO's default /socket.io path during rollout.
    // Keep v2 isolated here; this path can remain after v1 is retired.
    path: V2_SOCKET_PATH,
    auth: joinRequest,
    transports: ["websocket"],
    reconnection: true,
    reconnectionAttempts: 8,
    timeout: 10_000,
  });

  session.socket = socket;
  if (roomId) session.roomId = roomId;
  else delete session.roomId;
  delete session.lastSnapshot;
  session.latestRevision = -1;
  socket.on("room:joined", (snapshot) =>
    receiveSnapshot(session, socket, snapshot, false),
  );
  socket.on("room:updated", (snapshot) =>
    receiveSnapshot(session, socket, snapshot, true),
  );
  socket.on("room:error", (error) => {
    if (session.socket !== socket) return;
    postToContent(session, { type: "room:error", message: error.message });
    session.status = { state: "error", message: error.message };
    updatePopupForSession(session);
  });
  socket.on("connect_error", (error) => {
    if (session.socket !== socket) return;
    session.status = {
      state: "error",
      message: friendlyConnectionError(error.message),
    };
    postToContent(session, {
      type: "room:error",
      message: session.status.message,
    });
    updatePopupForSession(session);
  });
  socket.on("disconnect", (reason) => {
    if (session.socket !== socket || reason === "io client disconnect") return;
    session.status = { state: "connecting" };
    updatePopupForSession(session);
  });
}

function receiveSnapshot(
  session: TabSession,
  socket: SyncSocket,
  value: unknown,
  notifyAboutMembershipChanges: boolean,
): void {
  if (session.socket !== socket || !isRoomSnapshot(value)) return;
  if (value.revision < session.latestRevision) return;

  const previousMembers = session.lastSnapshot?.members ?? [];
  const previousMemberIds = new Set(previousMembers.map((member) => member.id));
  const currentMemberIds = new Set(value.members.map((member) => member.id));
  const joinedMembers = notifyAboutMembershipChanges
    ? value.members.filter(
        (member) =>
          member.id !== socket.id && !previousMemberIds.has(member.id),
      )
    : [];
  const departedMembers = notifyAboutMembershipChanges
    ? previousMembers.filter(
        (member) => member.id !== socket.id && !currentMemberIds.has(member.id),
      )
    : [];

  session.latestRevision = value.revision;
  session.roomId = value.roomId;
  session.lastSnapshot = value;
  session.status = {
    state: "connected",
    roomId: value.roomId,
    members: value.members.map((member) => ({
      username: member.username,
      isSelf: member.id === socket.id,
    })),
  };
  postToContent(session, { type: "room:snapshot", snapshot: value });
  for (const member of joinedMembers) {
    postToContent(session, {
      type: "room:member-joined",
      username: member.username,
    });
  }
  for (const member of departedMembers) {
    postToContent(session, {
      type: "room:member-left",
      username: member.username,
    });
  }
  updatePopupForSession(session);
}

function disconnectRoom(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) {
    sendPopupStatus({ state: "disconnected" });
    return;
  }

  session.connectionAttempt += 1;
  disconnectSocket(session);
  delete session.roomId;
  delete session.lastSnapshot;
  session.latestRevision = -1;
  session.status = { state: "disconnected" };
  postToContent(session, { type: "room:disconnected" });
  updatePopupForSession(session);
}

function disconnectSocket(session: TabSession): void {
  if (!session.socket) return;
  session.socket.removeAllListeners();
  session.socket.disconnect();
  delete session.socket;
}

function scheduleSessionRemoval(
  tabId: number,
  port: chrome.runtime.Port,
): void {
  const existing = pendingDisconnects.get(tabId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    pendingDisconnects.delete(tabId);
    const session = sessions.get(tabId);
    if (!session || session.port !== port) return;
    removeSession(tabId);
  }, 1_000);
  pendingDisconnects.set(tabId, timeout);
}

function removeSession(tabId: number): void {
  const pending = pendingDisconnects.get(tabId);
  if (pending) clearTimeout(pending);
  pendingDisconnects.delete(tabId);

  const session = sessions.get(tabId);
  if (!session) return;
  session.connectionAttempt += 1;
  disconnectSocket(session);
  sessions.delete(tabId);
  getActionApi().disable(tabId);
  if (popupTabId === tabId) sendPopupStatus({ state: "disconnected" });
}

function statusForTab(tabId: number): ConnectionStatus {
  return sessions.get(tabId)?.status ?? { state: "disconnected" };
}

function updatePopupForSession(session: TabSession): void {
  if (popupTabId === session.tabId) sendPopupStatus(session.status);
}

function sendPopupStatus(status: ConnectionStatus): void {
  const message: BackgroundToPopupMessage = { type: "popup:status", status };
  try {
    popupPort?.postMessage(message);
  } catch (error: unknown) {
    log("Popup was unavailable", error);
  }
}

function postToContent(
  session: TabSession,
  message: BackgroundToContentMessage,
): void {
  try {
    session.port.postMessage(message);
  } catch (error: unknown) {
    log("Content script was unavailable", error);
  }
}

function friendlyConnectionError(message: string): string {
  if (message === "invalid_request") return "This room link is invalid.";
  if (message === "server_full") return "The sync server is currently full.";
  return "Could not connect to the sync server.";
}

log("Service worker loaded");
