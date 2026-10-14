import { io, Socket } from "socket.io-client";
import _ from "lodash";

import { log, getParameterByName, setIconColor } from "./common";
import { Message, MessageTypes, PortName, States, TabInfo } from "./types";
import { extensionAPI, getActionAPI } from "./browser-compat";

declare const process: { env: { [key: string]: string | undefined } };
declare const self: ServiceWorkerGlobalScope;

const tabsInfo: { [index: number]: TabInfo | undefined } = {};
const serverUrl = process.env.SYNC_SERVER!;
const pendingDisconnects: { [index: number]: ReturnType<typeof setTimeout> | undefined } = {};
// Tabs where Create Room was clicked before their content script reconnected to this Service Worker
const pendingRoomCreations: { [index: number]: boolean | undefined } = {};
const CONNECTION_REQUEST_TIMEOUT_MS = 5000;
const SERVER_UNREACHABLE_ERROR = "Could not reach the sync server, retrying...";
const RELOAD_PAGE_ERROR = "Could not find the video player. Reload the page and try again.";

let popupPort: chrome.runtime.Port | undefined = undefined;

// The Service Worker can be stopped at any time, so the room of each tab is kept in session storage
// to rejoin it after a restart.
function roomStorageKey(tabId: number): string {
  return `room_${tabId}`;
}

async function getPersistedRoomId(tabId: number): Promise<string | undefined> {
  const session = extensionAPI.storage.session;
  if (!session) {
    return undefined;
  }
  const key = roomStorageKey(tabId);
  const data = await session.get(key);
  return data[key];
}

function persistRoomId(tabId: number, roomId: string | undefined): void {
  const session = extensionAPI.storage.session;
  if (!session) {
    return;
  }
  const key = roomStorageKey(tabId);
  const result = roomId ? session.set({ [key]: roomId }) : session.remove(key);
  result.catch((error: unknown) => log("Failed to persist room", error));
}

function postToContentScript(tabId: number, message: Message): void {
  try {
    tabsInfo[tabId]?.port.postMessage(message);
  } catch (error) {
    log("Failed to send message to contentScript", tabId, error);
  }
}

async function handleContentScriptConnection(
  port: chrome.runtime.Port,
  reconnect: boolean,
  inRoom: boolean
): Promise<void> {
  const tabId = port.sender?.tab?.id;
  const url = port.sender?.tab?.url ?? "";
  if (tabId === undefined) {
    return;
  }

  if (pendingDisconnects[tabId]) {
    clearTimeout(pendingDisconnects[tabId]);
    delete pendingDisconnects[tabId];
  }
  getActionAPI().enable(tabId);

  const urlRoomId: string | null = getParameterByName(url, "rollTogetherRoom");
  const existingInfo = tabsInfo[tabId];
  if (existingInfo) {
    existingInfo.port = port;
    existingInfo.connectionRequestedAt = undefined;

    if (existingInfo.socket && existingInfo.roomId) {
      if (reconnect || _.isNil(urlRoomId) || urlRoomId === existingInfo.roomId) {
        // Page reloaded while in a room: bring the new player to the room's state
        resyncContentScript(tabId);
        return;
      }
      // The page was opened with a link to a different room
      disconnectWebsocket(tabId);
    }
  } else {
    tabsInfo[tabId] = { port, tabId };
  }

  let roomId: string | undefined = undefined;
  let shouldConnect: boolean = false;
  if (pendingRoomCreations[tabId]) {
    delete pendingRoomCreations[tabId];
    roomId = urlRoomId ?? undefined;
    shouldConnect = true;
  } else if (!reconnect) {
    // New page: join the room from the link, or the one this tab was in before a reload
    roomId = urlRoomId ?? (await getPersistedRoomId(tabId));
    shouldConnect = !_.isNil(roomId);
  } else if (inRoom) {
    // This Service Worker was restarted while the page was in a room
    roomId = await getPersistedRoomId(tabId);
    shouldConnect = !_.isNil(roomId);
  }

  if (shouldConnect && tabsInfo[tabId]?.port === port) {
    sendConnectionRequestToContentScript(tabId, roomId);
  }
}

function wakeContentScript(tabId: number): void {
  pendingRoomCreations[tabId] = true;
  try {
    extensionAPI.tabs
      .sendMessage(tabId, { type: MessageTypes.SW2CS_RECONNECT })
      .catch((error: unknown) => log("Failed to wake contentScript", error));
  } catch (error) {
    log("Failed to wake contentScript", error);
  }

  setTimeout(() => {
    if (pendingRoomCreations[tabId]) {
      delete pendingRoomCreations[tabId];
      tryUpdatePopup(tabId, RELOAD_PAGE_ERROR);
    }
  }, CONNECTION_REQUEST_TIMEOUT_MS);
}

function handleContentScriptDisconnection(port: chrome.runtime.Port): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    return;
  }

  // Delay cleanup to allow a reconnect (page reload) to cancel it
  pendingDisconnects[tabId] = setTimeout(() => {
    delete pendingDisconnects[tabId];
    const tabInfo = tabsInfo[tabId];

    // If the port was already replaced by a new connection, skip cleanup
    if (tabInfo && tabInfo.port !== port) {
      log("Ignoring stale port disconnect for tab", tabId);
      return;
    }

    getActionAPI().disable(tabId);
    // Keep the persisted room so a slow reload can still rejoin it
    disconnectWebsocket(tabId, false);
    delete tabsInfo[tabId];
  }, 3000);
}

function tryUpdatePopup(tabId: number, error: string | undefined = undefined): void {
  const roomId = tabsInfo[tabId]?.roomId;
  log("Trying to update popup", { tabId, roomId, error });
  try {
    popupPort?.postMessage({
      type: MessageTypes.SW2PU_SEND_ROOM_ID,
      tabId,
      roomId,
      error,
    });
  } catch (err) {
    log("Failed to update popup", err);
  }
}

function disconnectWebsocket(tabId: number, forgetRoom: boolean = true): void {
  log("Disconnecting websocket", tabId);
  const tabInfo = tabsInfo[tabId];
  if (forgetRoom) {
    persistRoomId(tabId, undefined);
  }
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  if (tabInfo.socket) {
    tabInfo.socket.disconnect();
    delete tabInfo.socket;
  }
  delete tabInfo.roomId;
  delete tabInfo.requestedRoomId;
  delete tabInfo.connectionRequestedAt;

  postToContentScript(tabId, { type: MessageTypes.SW2CS_ROOM_DISCONNECT });
  tryUpdatePopup(tabId);
}

function handlePopupMessage(message: Message, port: chrome.runtime.Port): void {
  switch (message.type) {
    case MessageTypes.PU2SW_CREATE_ROOM: {
      const tabInfo = tabsInfo[message.tabId];
      if (!tabInfo) {
        wakeContentScript(message.tabId);
        return;
      }
      const urlRoomId = getParameterByName(tabInfo.port.sender?.tab?.url ?? "");
      sendConnectionRequestToContentScript(message.tabId, urlRoomId ?? undefined);
      break;
    }
    case MessageTypes.PU2SW_DISCONNECT_ROOM:
      disconnectWebsocket(message.tabId);
      break;
    case MessageTypes.PU2SW_REQUEST_ROOM_ID: {
      const tabInfo = tabsInfo[message.tabId];
      const connecting = tabInfo?.socket && !tabInfo.socket.connected && !tabInfo.roomId;
      tryUpdatePopup(message.tabId, connecting ? SERVER_UNREACHABLE_ERROR : undefined);
      break;
    }
    default:
      log("Invalid PopupMessageType " + message.type);
  }
}

function handleContentScriptMessage(
  message: Message,
  port: chrome.runtime.Port
): void {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    return;
  }
  log("Received message from contentScript", { tabId, message });

  switch (message.type) {
    case MessageTypes.CS2SW_HELLO:
      handleContentScriptConnection(port, message.reconnect, message.inRoom).catch(
        (error) => log("Failed to handle contentScript connection", error)
      );
      break;
    case MessageTypes.CS2SW_REQUEST_RESYNC:
      if (tabsInfo[tabId]?.socket && tabsInfo[tabId]?.roomId) {
        resyncContentScript(tabId);
      }
      break;
    case MessageTypes.CS2SW_HEART_BEAT:
      syncContentScript(tabId, true);
      break;
    case MessageTypes.CS2SW_ROOM_CONNECTION:
      connectWebsocket(tabId, message.currentProgress, message.state);
      break;
    case MessageTypes.CS2SW_LOCAL_UPDATE: {
      const tabInfo = tabsInfo[tabId];
      // socket.io buffers emits while offline and replays them after rejoining, which would rewind the room
      if (!tabInfo?.socket?.connected || !tabInfo.roomId) {
        return;
      }
      tabInfo.lastKnownProgress = message.currentProgress;
      tabInfo.socket.emit("update", message.state, message.currentProgress);
      break;
    }
    default:
      log("Invalid ContentScriptMessageType " + message.type);
  }
}

function sendUpdateToContentScript(
  tabId: number,
  roomState: States,
  roomProgress: number,
  sync: boolean = false
): void {
  log("Sending update to contentScript", { tabId, roomState, roomProgress, sync });

  const tabInfo = tabsInfo[tabId];
  if (tabInfo) {
    tabInfo.lastKnownProgress = roomProgress;
  }
  postToContentScript(tabId, {
    type: MessageTypes.SW2CS_REMOTE_UPDATE,
    roomState,
    roomProgress,
    sync,
  });
}

// Asks the server for the room's current state and forwards it to the content script
function syncContentScript(tabId: number, driftCorrectionOnly: boolean): void {
  const socket = tabsInfo[tabId]?.socket;
  if (!socket?.connected || !tabsInfo[tabId]?.roomId) {
    return;
  }

  socket.emit("sync", (roomState: States, roomProgress: number) => {
    if (tabsInfo[tabId]?.socket !== socket) {
      return;
    }
    sendUpdateToContentScript(tabId, roomState, roomProgress, driftCorrectionOnly);
  });
}

function resyncContentScript(tabId: number): void {
  const tabInfo = tabsInfo[tabId]!;
  const socket = tabInfo.socket!;
  log("Resyncing contentScript with its room", { tabId, roomId: tabInfo.roomId });

  if (!socket.connected) {
    // The socket's next join event delivers the room state
    return;
  }

  socket.emit("sync", (roomState: States, roomProgress: number) => {
    if (tabsInfo[tabId]?.socket !== socket) {
      return;
    }
    // Apply the room state before local events are sent, so the fresh player doesn't drag the room along
    sendUpdateToContentScript(tabId, roomState, roomProgress);
    postToContentScript(tabId, { type: MessageTypes.SW2CS_ROOM_JOINED });
  });
}

function sendConnectionRequestToContentScript(
  tabId: number,
  roomId: string | undefined
): void {
  const tabInfo = tabsInfo[tabId];
  log({ tabsInfo, tabInfo, tabId, roomId });

  if (tabInfo == undefined) {
    log(`No tab info found for tab ${tabId}`);
    tryUpdatePopup(tabId, RELOAD_PAGE_ERROR);
    return;
  }

  if (
    tabInfo.connectionRequestedAt &&
    Date.now() - tabInfo.connectionRequestedAt < CONNECTION_REQUEST_TIMEOUT_MS
  ) {
    log("Connection request already sent to contentScript", { tabId });
    return;
  }

  if (tabInfo.socket) {
    if (tabInfo.roomId && (_.isNil(roomId) || roomId === tabInfo.roomId)) {
      return;
    }
    // Either connected to another room, or still failing to connect: start over
    disconnectWebsocket(tabId);
  }

  log("Sending connection request to contentScript", { tabId, roomId });
  tabInfo.connectionRequestedAt = Date.now();
  tabInfo.requestedRoomId = roomId;
  postToContentScript(tabId, { type: MessageTypes.SW2CS_ROOM_CONNECTION });
}

function buildConnectionQuery(tabInfo: TabInfo, videoState: States): { [key: string]: string } {
  const query: { [key: string]: string } = {
    videoProgress: `${Math.round(tabInfo.lastKnownProgress ?? 0)}`,
    videoState,
  };
  const roomId = tabInfo.roomId ?? tabInfo.requestedRoomId;
  if (roomId) {
    query.room = roomId;
  }
  return query;
}

function connectWebsocket(
  tabId: number,
  videoProgress: number,
  videoState: States
) {
  const tabInfo = tabsInfo[tabId];
  log("Connecting websocket", {
    tabId,
    videoProgress,
    videoState,
    roomId: tabInfo?.requestedRoomId,
  });
  if (!tabInfo) {
    log(`No tab info found for tab ${tabId}`);
    return;
  }

  if (tabInfo.socket) {
    log(
      `Socket is already configured for tab ${tabId}. Disconnect existing connection before attempting to connect.`
    );
    return;
  }

  tabInfo.lastKnownProgress = videoProgress;
  const socket = io(serverUrl, {
    query: buildConnectionQuery(tabInfo, videoState),
    transports: ["websocket"],
  });
  tabInfo.socket = socket;

  // The query is fixed at creation, so refresh it to rejoin the same room
  // (the creator connected without one) at the current position
  socket.io.on("reconnect_attempt", () => {
    socket.io.opts.query = buildConnectionQuery(tabInfo, videoState);
  });

  socket.on("connect_error", (error: Error) => {
    log("Failed to connect to the sync server", error);
    if (!tabInfo.roomId) {
      tryUpdatePopup(tabId, SERVER_UNREACHABLE_ERROR);
    }
  });

  socket.on(
    "join",
    (receivedRoomId: string, roomState: States, roomProgress: number): void => {
      if (tabInfo.socket !== socket) {
        return;
      }
      tabInfo.roomId = receivedRoomId;
      delete tabInfo.connectionRequestedAt;
      log("Sucessfully joined a room", {
        roomId: tabInfo.roomId,
        roomState,
        roomProgress,
      });
      persistRoomId(tabId, receivedRoomId);
      tryUpdatePopup(tabId);
      getActionAPI().enable(tabId);

      sendUpdateToContentScript(tabId, roomState, roomProgress);
      postToContentScript(tabId, { type: MessageTypes.SW2CS_ROOM_JOINED });
    }
  );

  socket.on(
    "update",
    (id: string, roomState: States, roomProgress: number): void => {
      if (tabInfo.socket !== socket) {
        return;
      }
      log("Received update Message from ", id, { roomState, roomProgress });
      sendUpdateToContentScript(tabId, roomState, roomProgress);
    }
  );
}

extensionAPI.runtime.onConnect.addListener(function (port: chrome.runtime.Port) {
  log("Port connected", port.name);
  switch (port.name) {
    case PortName.POPUP:
      popupPort = port;
      log("Popup connected");

      port.onDisconnect.addListener(() => {
        if (popupPort === port) {
          popupPort = undefined;
        }
        log("Popup disconnected");
      });
      port.onMessage.addListener(handlePopupMessage);
      break;
    case PortName.CONTENT_SCRIPT:
      // The connection is handled once the content script sends CS2SW_HELLO
      log(`${port.name} connected`, port.sender?.tab?.id);

      port.onDisconnect.addListener(() => {
        handleContentScriptDisconnection(port);
        log(`${port.name} disconnected`, port.sender?.tab?.id);
      });

      port.onMessage.addListener(handleContentScriptMessage);
      break;
    default:
      log("Invalid PortName " + port.name);
  }
});

extensionAPI.tabs.onRemoved.addListener((tabId: number) => {
  persistRoomId(tabId, undefined);
});

extensionAPI.runtime.onInstalled.addListener(() => {
  const canvas = new OffscreenCanvas(128, 128);
  const ctx = canvas.getContext("2d")! as OffscreenCanvasRenderingContext2D;
  setIconColor(canvas, ctx);
});

getActionAPI().disable();
self.addEventListener = _.noop;

log("Service Worker Loaded");
