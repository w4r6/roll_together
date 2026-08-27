import {
  MAX_VIDEO_PROGRESS_SECONDS,
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
import {
  getEpisodePathFromUrl,
  getOrCreateUsername,
  getRoomEpisodeUrl,
  updateActionIcon,
} from "./common";
import {
  createDiagnosticLogger,
  developmentDiagnosticsUrl,
  installGlobalDiagnosticHandlers,
  isDiagnosticMessage,
  type DiagnosticEntry,
} from "./diagnostics";
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
  lastSnapshotReceivedAtMs: number;
  awaitingInitialSnapshotRevision?: number;
  latestRevision: number;
  connectionAttempt: number;
  status: ConnectionStatus;
  episodePath: string | undefined;
  pendingLocalEpisodePath: string | undefined;
  awaitingLocalPlaybackPath: string | undefined;
  navigatingToEpisodePath: string | undefined;
}

const serverUrl = process.env.SYNC_SERVER;
if (!serverUrl) throw new Error("SYNC_SERVER is not configured");

const sessions = new Map<number, TabSession>();
const pendingDisconnects = new Map<number, ReturnType<typeof setTimeout>>();
const pendingDiagnostics: DiagnosticEntry[] = [];
let popupPort: chrome.runtime.Port | undefined;
let popupTabId: number | undefined;
let diagnosticsFlushTimer: ReturnType<typeof setTimeout> | undefined;
let diagnosticsRetryDelayMs = 500;

const log = createDiagnosticLogger("service_worker", enqueueDiagnostic);
installGlobalDiagnosticHandlers(log);

chrome.runtime.onMessage.addListener((value: unknown, sender) => {
  if (!isDiagnosticMessage(value)) return;
  enqueueDiagnostic({
    ...value.entry,
    details: {
      ...(isPlainObject(value.entry.details)
        ? value.entry.details
        : value.entry.details === undefined
          ? {}
          : { value: value.entry.details }),
      sender: {
        tabId: sender.tab?.id,
        frameId: sender.frameId,
        url: sender.url,
      },
    },
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PortName.POPUP) {
    connectPopup(port);
    return;
  }
  if (port.name === PortName.CONTENT) {
    connectContentScript(port);
    return;
  }
  log("unknown_port_ignored", { portName: port.name }, "warn");
});

chrome.runtime.onInstalled.addListener(() => {
  log("extension_installed", { reason: "runtime_on_installed" }, "info");
  getActionApi().disable();
  void getOrCreateUsername().catch((error: unknown) =>
    log("username_initialization_failed", { error }, "error"),
  );
  void updateActionIcon().catch((error: unknown) =>
    log("action_icon_initialization_failed", { error }, "error"),
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) handleTabUrlUpdate(tabId, changeInfo.url);
});

function connectPopup(port: chrome.runtime.Port): void {
  log("popup_connected");
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
      log("popup_disconnected");
      popupPort = undefined;
      popupTabId = undefined;
    }
  });
}

function connectContentScript(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    log("content_port_missing_tab", undefined, "warn");
    port.disconnect();
    return;
  }

  log("content_connected", {
    tabId,
    frameId: port.sender?.frameId ?? 0,
    url: port.sender?.tab?.url,
  });

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
    const episodePath = getEpisodePathFromUrl(port.sender?.tab?.url ?? "");
    const session: TabSession = existing ?? {
      tabId,
      frameId,
      port,
      latestRevision: -1,
      connectionAttempt: 0,
      status: { state: "disconnected" },
      lastSnapshotReceivedAtMs: 0,
      episodePath,
      pendingLocalEpisodePath: undefined,
      awaitingLocalPlaybackPath: undefined,
      navigatingToEpisodePath: undefined,
    };
    session.port = port;
    session.frameId = frameId;
    session.episodePath = episodePath;

    sessions.set(tabId, session);
    log("content_ready", {
      tabId,
      frameId,
      episodePath,
      roomId: message.roomId,
      playback: message.playback,
      resumedSession: existing !== undefined,
    });
    getActionApi().enable(tabId);
    if (session.navigatingToEpisodePath === episodePath) {
      session.navigatingToEpisodePath = undefined;
    }

    const currentSnapshot = snapshotAtCurrentTime(session);
    if (currentSnapshot) {
      postToContent(session, {
        type: "room:snapshot",
        snapshot: currentSnapshot,
      });
    }

    if (message.roomId && message.roomId !== session.roomId) {
      void connectRoom(session, message.playback, message.roomId);
    } else if (
      session.awaitingLocalPlaybackPath === episodePath &&
      session.socket?.connected
    ) {
      session.awaitingLocalPlaybackPath = undefined;
      session.socket.emit("playback:update", message.playback);
    }
    return;
  }

  const session = sessions.get(tabId);
  if (!session || session.port !== port) return;

  if (message.type === "room:connect") {
    log("room_connect_received", {
      tabId,
      roomId: message.roomId,
      playback: message.playback,
    });
    void connectRoom(session, message.playback, message.roomId);
    return;
  }

  if (message.type === "room:snapshot-applied") {
    if (
      session.awaitingInitialSnapshotRevision !== undefined &&
      message.revision >= session.awaitingInitialSnapshotRevision
    ) {
      log("initial_room_snapshot_application_confirmed", {
        tabId,
        roomId: session.roomId,
        revision: message.revision,
      });
      delete session.awaitingInitialSnapshotRevision;
    }
    return;
  }

  if (message.type === "playback:update" && session.socket?.connected) {
    const roomSnapshot = snapshotAtCurrentTime(session);
    if (session.awaitingInitialSnapshotRevision !== undefined && roomSnapshot) {
      log("join_playback_update_held_for_host", {
        tabId,
        roomId: session.roomId,
        playback: message.playback,
        roomState: roomSnapshot.state,
        roomProgress: roomSnapshot.progress,
      });
      postToContent(session, {
        type: "room:snapshot",
        snapshot: roomSnapshot,
      });
      return;
    }

    log("playback_update_sent", {
      tabId,
      roomId: session.roomId,
      playback: message.playback,
    });
    session.socket.emit("playback:update", message.playback);
  }
}

function requestRoomConnection(tabId: number): void {
  const session = sessions.get(tabId);
  if (!session) {
    log("room_connect_missing_session", { tabId }, "warn");
    sendPopupStatus({
      state: "error",
      message: "No Crunchyroll video was found in this tab.",
    });
    return;
  }

  session.status = { state: "connecting" };
  log("room_connect_requested", { tabId });
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

  log("socket_connect_started", {
    tabId: session.tabId,
    connectionAttempt,
    roomId,
    episodePath: session.episodePath,
    playback,
  });

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
    log("username_load_failed", { error, tabId: session.tabId }, "error");
    return;
  }
  if (session.connectionAttempt !== connectionAttempt) return;

  const joinRequest: JoinRequest = {
    ...playback,
    protocolVersion: PROTOCOL_VERSION,
    username,
    ...(roomId ? { roomId } : {}),
    ...(session.episodePath ? { episodePath: session.episodePath } : {}),
  };

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
  session.lastSnapshotReceivedAtMs = 0;
  delete session.awaitingInitialSnapshotRevision;
  session.latestRevision = -1;
  session.pendingLocalEpisodePath = undefined;
  session.awaitingLocalPlaybackPath = undefined;
  session.navigatingToEpisodePath = undefined;
  socket.on("room:joined", (snapshot) =>
    receiveSnapshot(session, socket, snapshot, false),
  );
  socket.on("room:updated", (snapshot) =>
    receiveSnapshot(session, socket, snapshot, true),
  );
  socket.on("room:error", (error) => {
    if (session.socket !== socket) return;
    log(
      "server_room_error",
      {
        tabId: session.tabId,
        roomId: session.roomId,
        code: error.code,
        message: error.message,
      },
      "warn",
    );
    postToContent(session, { type: "room:error", message: error.message });
    session.status = { state: "error", message: error.message };
    updatePopupForSession(session);
  });
  socket.on("connect_error", (error) => {
    if (session.socket !== socket) return;
    log(
      "socket_connect_failed",
      {
        tabId: session.tabId,
        roomId: session.roomId,
        connectionAttempt,
        error,
      },
      "error",
    );
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
    log(
      "socket_disconnected_unexpectedly",
      {
        tabId: session.tabId,
        roomId: session.roomId,
        reason,
      },
      "warn",
    );
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
  if (session.socket !== socket) {
    log("snapshot_ignored_stale_socket", { tabId: session.tabId });
    return;
  }
  if (!isRoomSnapshot(value)) {
    log("snapshot_rejected_invalid", { tabId: session.tabId, value }, "warn");
    return;
  }
  if (value.revision < session.latestRevision) {
    log("snapshot_ignored_old_revision", {
      tabId: session.tabId,
      receivedRevision: value.revision,
      latestRevision: session.latestRevision,
    });
    return;
  }

  log("snapshot_received", {
    tabId: session.tabId,
    roomId: value.roomId,
    revision: value.revision,
    state: value.state,
    progress: value.progress,
    episodePath: value.episodePath,
    memberCount: value.members.length,
  });

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
  session.lastSnapshotReceivedAtMs = Date.now();
  if (!notifyAboutMembershipChanges && value.members.length > 1) {
    session.awaitingInitialSnapshotRevision = value.revision;
  } else if (session.awaitingInitialSnapshotRevision !== undefined) {
    session.awaitingInitialSnapshotRevision = value.revision;
  }
  if (value.episodePath === session.pendingLocalEpisodePath) {
    session.pendingLocalEpisodePath = undefined;
  }
  session.status = {
    state: "connected",
    roomId: value.roomId,
    members: value.members.map((member) => ({
      username: member.username,
      isSelf: member.id === socket.id,
    })),
  };
  if (
    value.episodePath &&
    value.episodePath !== session.episodePath &&
    session.pendingLocalEpisodePath !== session.episodePath
  ) {
    navigateToRoomEpisode(session, value.episodePath, value.roomId);
  } else {
    postToContent(session, {
      type: "room:snapshot",
      snapshot: snapshotAtCurrentTime(session) ?? value,
    });
  }
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
    log("room_disconnect_missing_session", { tabId });
    sendPopupStatus({ state: "disconnected" });
    return;
  }

  session.connectionAttempt += 1;
  log("room_disconnect_requested", { tabId, roomId: session.roomId });
  disconnectSocket(session);
  delete session.roomId;
  delete session.lastSnapshot;
  session.lastSnapshotReceivedAtMs = 0;
  delete session.awaitingInitialSnapshotRevision;
  session.latestRevision = -1;
  session.pendingLocalEpisodePath = undefined;
  session.awaitingLocalPlaybackPath = undefined;
  session.navigatingToEpisodePath = undefined;
  session.status = { state: "disconnected" };
  postToContent(session, { type: "room:disconnected" });
  updatePopupForSession(session);
}

function disconnectSocket(session: TabSession): void {
  if (!session.socket) return;
  log("socket_disconnect_started", {
    tabId: session.tabId,
    roomId: session.roomId,
    connected: session.socket.connected,
  });
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
  log("tab_session_removed", { tabId, roomId: session.roomId });
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
    log("popup_message_failed", { error }, "warn");
  }
}

function postToContent(
  session: TabSession,
  message: BackgroundToContentMessage,
): void {
  try {
    session.port.postMessage(message);
  } catch (error: unknown) {
    log(
      "content_message_failed",
      { tabId: session.tabId, messageType: message.type, error },
      "warn",
    );
  }
}

function snapshotAtCurrentTime(session: TabSession): RoomSnapshot | undefined {
  const snapshot = session.lastSnapshot;
  if (!snapshot || snapshot.state !== "playing") return snapshot;

  const elapsedSeconds = Math.max(
    0,
    (Date.now() - session.lastSnapshotReceivedAtMs) / 1_000,
  );
  return {
    ...snapshot,
    progress: Math.min(
      snapshot.progress + elapsedSeconds,
      MAX_VIDEO_PROGRESS_SECONDS,
    ),
  };
}

function handleTabUrlUpdate(tabId: number, url: string): void {
  const session = sessions.get(tabId);
  if (!session) return;

  const episodePath = getEpisodePathFromUrl(url);
  if (!episodePath) return;

  session.episodePath = episodePath;
  if (session.navigatingToEpisodePath === episodePath) {
    session.navigatingToEpisodePath = undefined;
    return;
  }

  if (
    !session.socket?.connected ||
    !session.lastSnapshot ||
    session.lastSnapshot.episodePath === episodePath
  ) {
    return;
  }

  session.pendingLocalEpisodePath = episodePath;
  session.awaitingLocalPlaybackPath = episodePath;
  log("local_episode_update_sent", {
    tabId,
    roomId: session.roomId,
    episodePath,
  });
  session.socket.emit("episode:update", episodePath);
}

function navigateToRoomEpisode(
  session: TabSession,
  episodePath: string,
  roomId: string,
): void {
  session.navigatingToEpisodePath = episodePath;
  const url = getRoomEpisodeUrl(episodePath, roomId);
  chrome.tabs.update(session.tabId, { url }, () => {
    const error = chrome.runtime.lastError;
    if (!error) return;
    if (session.navigatingToEpisodePath === episodePath) {
      session.navigatingToEpisodePath = undefined;
    }
    log(
      "synchronized_episode_navigation_failed",
      { tabId: session.tabId, episodePath, error: error.message },
      "error",
    );
  });
}

function friendlyConnectionError(message: string): string {
  if (message === "invalid_request") return "This room link is invalid.";
  if (message === "server_full") return "The sync server is currently full.";
  return "Could not connect to the sync server.";
}

function enqueueDiagnostic(entry: DiagnosticEntry): void {
  pendingDiagnostics.push(entry);
  if (pendingDiagnostics.length > 500) pendingDiagnostics.shift();
  scheduleDiagnosticsFlush(100);
}

function scheduleDiagnosticsFlush(delayMs: number): void {
  if (diagnosticsFlushTimer || !developmentDiagnosticsUrl()) return;
  diagnosticsFlushTimer = setTimeout(() => {
    diagnosticsFlushTimer = undefined;
    void flushDiagnostics();
  }, delayMs);
}

async function flushDiagnostics(): Promise<void> {
  const url = developmentDiagnosticsUrl();
  if (!url || pendingDiagnostics.length === 0) return;

  const entries = pendingDiagnostics.splice(0, 100);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    if (!response.ok)
      throw new Error(`Debug collector returned ${response.status}`);
    diagnosticsRetryDelayMs = 500;
    if (pendingDiagnostics.length > 0) scheduleDiagnosticsFlush(25);
  } catch {
    pendingDiagnostics.unshift(...entries);
    if (pendingDiagnostics.length > 500)
      pendingDiagnostics.splice(0, pendingDiagnostics.length - 500);
    scheduleDiagnosticsFlush(diagnosticsRetryDelayMs);
    diagnosticsRetryDelayMs = Math.min(diagnosticsRetryDelayMs * 2, 10_000);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

log(
  "service_worker_loaded",
  {
    extensionVersion: chrome.runtime.getManifest().version,
    protocolVersion: PROTOCOL_VERSION,
    serverUrl,
    userAgent: navigator.userAgent,
  },
  "info",
);
