import _ from "lodash";

import { LIMIT_DELTA_TIME, log, getEnumKeys } from "./common";

import {
  States,
  Actions,
  PlayerStateProp,
  MessageTypes,
  Message,
  PortName,
} from "./types";
import { extensionAPI } from "./browser-compat";

const HEART_BEAT_INTERVAL_MS = 10000; // Keeps the Service Worker alive and triggers drift correction
const EXPECTED_STATE_WINDOW_MS = 1500;
const LOCAL_ACTION_GRACE_MS = 2000;
const MIN_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 30000;
const HEALTHY_CONNECTION_MS = 5000;
// Keeps bursts of local actions under the server's rate limit; the trailing call always sends the final state
const LOCAL_UPDATE_THROTTLE_MS = 250;

let g_port: chrome.runtime.Port | undefined = undefined;
let g_hasConnected: boolean = false;
let g_reconnectDelay: number = MIN_RECONNECT_DELAY_MS;
let g_player: HTMLVideoElement | undefined = undefined;
let g_lastFrameProgress: number | undefined = undefined;
let g_heartBeatInterval: ReturnType<typeof setInterval> | undefined = undefined;
let g_playPromise: Promise<void> | undefined = undefined;
let g_inRoom: boolean = false;
// Local events are held back until the room state has been applied to a new player
let g_awaitingResync: boolean = false;
let g_lastLocalActionAt: number = 0;
// State the player should reach after applying a remote update.
// Local events matching it are echoes of that update and must not be sent back.
let g_expected:
  | { state: States; progress: number; until: number }
  | undefined = undefined;

function connectPort(inRoom: boolean = false): void {
  // The extension was reloaded or updated, this content script is orphaned
  if (g_port || !extensionAPI.runtime?.id) {
    return;
  }

  const connectedAt = Date.now();
  const port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });
  g_port = port;

  port.onMessage.addListener(handleServiceWorkerMessage);
  port.onDisconnect.addListener(() => {
    // The Service Worker was stopped (idle timeout, update)
    const wasInRoom = g_inRoom;
    g_port = undefined;
    leaveRoom();

    // Outside a room there is nothing to restore; the Service Worker wakes us with SW2CS_RECONNECT when needed
    if (!wasInRoom) {
      log("Port disconnected");
      return;
    }

    log("Port disconnected while in a room, reconnecting");
    if (Date.now() - connectedAt > HEALTHY_CONNECTION_MS) {
      g_reconnectDelay = MIN_RECONNECT_DELAY_MS;
    }
    setTimeout(() => connectPort(true), g_reconnectDelay);
    g_reconnectDelay = Math.min(g_reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  });

  postToServiceWorker({
    type: MessageTypes.CS2SW_HELLO,
    reconnect: g_hasConnected,
    inRoom,
  });
  g_hasConnected = true;
}

function postToServiceWorker(message: Message): void {
  if (!g_port) {
    log("Port not connected, dropping message", message);
    return;
  }
  try {
    g_port.postMessage(message);
  } catch (error) {
    log("Failed to send message to Service Worker", error);
  }
}

function getState(stateName: PlayerStateProp): boolean | number {
  return g_player![stateName];
}

function getStates(): {
  state: States;
  currentProgress: number;
  timeJump: boolean;
} {
  const [paused, currentProgress]: [boolean, number] = [
    getState("paused") as boolean,
    getState("currentTime") as number,
  ];

  g_lastFrameProgress = g_lastFrameProgress ?? currentProgress;

  const timeJump: boolean =
    Math.abs(currentProgress - g_lastFrameProgress) > LIMIT_DELTA_TIME;
  const state: States = paused ? States.PAUSED : States.PLAYING;

  g_lastFrameProgress = currentProgress;
  return { state, currentProgress, timeJump };
}

function isEchoOfRemoteUpdate(state: States, progress: number): boolean {
  if (!g_expected) {
    return false;
  }
  if (Date.now() > g_expected.until) {
    g_expected = undefined;
    return false;
  }
  return (
    state === g_expected.state &&
    Math.abs(progress - g_expected.progress) <= LIMIT_DELTA_TIME
  );
}

const sendLocalUpdate = _.throttle(
  (state: States, currentProgress: number): void => {
    postToServiceWorker({
      type: MessageTypes.CS2SW_LOCAL_UPDATE,
      state,
      currentProgress,
    });
  },
  LOCAL_UPDATE_THROTTLE_MS
);

const handleLocalAction =
  (action: Actions) =>
  (event: Event): void => {
    // Ignore events from a player element that has since been replaced
    if (event.target !== g_player) {
      return;
    }

    const {
      state,
      currentProgress,
      timeJump,
    }: { state: States; currentProgress: number; timeJump: boolean } =
      getStates();

    if (!g_inRoom || g_awaitingResync) {
      return;
    }
    if (isEchoOfRemoteUpdate(state, currentProgress)) {
      log("Ignoring echo of remote update", action);
      return;
    }

    log("Local Action", action, { state, currentProgress, timeJump });
    switch (action) {
      case Actions.PLAY:
      case Actions.PAUSE:
        g_lastLocalActionAt = Date.now();
        sendLocalUpdate(state, currentProgress);
        break;
      case Actions.TIME_UPDATE:
        if (timeJump) {
          g_lastLocalActionAt = Date.now();
          sendLocalUpdate(state, currentProgress);
        }
        break;
    }
  };

function applyRoomState(roomState: States, seekTo: number | undefined): void {
  const player = g_player!;

  if (roomState === States.PAUSED) {
    const pauseAndSeek = (): void => {
      player.pause();
      if (seekTo !== undefined) {
        player.currentTime = seekTo;
      }
    };
    if (g_playPromise) {
      // Pausing while play() is pending rejects it, so wait for it to settle
      g_playPromise.catch(_.noop).then(pauseAndSeek);
      g_playPromise = undefined;
    } else {
      pauseAndSeek();
    }
    return;
  }

  if (seekTo !== undefined) {
    player.currentTime = seekTo;
  }
  if (player.paused) {
    g_playPromise = player.play();
    g_playPromise.catch((error) => {
      log("Playback was blocked", error);
      g_expected = undefined;
    });
  }
}

function sendRoomConnectionMessage(): void {
  const { state, currentProgress }: { state: States; currentProgress: number } =
    getStates();
  const type = MessageTypes.CS2SW_ROOM_CONNECTION;
  postToServiceWorker({ state, currentProgress, type });
}

function handleRemoteUpdate(message: Message): void {
  if (message.type != MessageTypes.SW2CS_REMOTE_UPDATE) {
    throw "Invalid Message Type: " + message.type;
  }
  const { roomState, roomProgress, sync } = message;
  log("Handling Remote Update", { roomState, roomProgress, sync });

  if (!Number.isFinite(roomProgress)) {
    log("Ignoring remote update with invalid progress", roomProgress);
    return;
  }

  const { state, currentProgress }: { state: States; currentProgress: number } =
    getStates();
  const outOfSync = Math.abs(roomProgress - currentProgress) > LIMIT_DELTA_TIME;

  if (sync) {
    // Drift correction only adjusts the position, and must not undo a local action still in flight
    const recentLocalAction =
      Date.now() - g_lastLocalActionAt < LOCAL_ACTION_GRACE_MS;
    if (state !== roomState || !outOfSync || recentLocalAction) {
      return;
    }
  }

  if (state === roomState && !outOfSync) {
    return;
  }

  g_expected = {
    state: roomState,
    progress: roomProgress,
    until: Date.now() + EXPECTED_STATE_WINDOW_MS,
  };
  if (outOfSync) {
    // Prevents the seek from being detected as a local time jump
    g_lastFrameProgress = roomProgress;
  }
  applyRoomState(roomState, outOfSync ? roomProgress : undefined);
}

function enterRoom(): void {
  g_inRoom = true;
  g_awaitingResync = false;
  if (g_heartBeatInterval) {
    clearInterval(g_heartBeatInterval);
  }
  g_heartBeatInterval = setInterval(
    () => postToServiceWorker({ type: MessageTypes.CS2SW_HEART_BEAT }),
    HEART_BEAT_INTERVAL_MS
  );
}

function leaveRoom(): void {
  g_inRoom = false;
  g_awaitingResync = false;
  sendLocalUpdate.cancel();
  g_expected = undefined;
  if (g_heartBeatInterval) {
    clearInterval(g_heartBeatInterval);
    g_heartBeatInterval = undefined;
  }
}

function handleServiceWorkerMessage(serviceWorkerMessage: Message) {
  log("Received message from Background", serviceWorkerMessage);

  switch (serviceWorkerMessage.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION:
      sendRoomConnectionMessage();
      break;
    case MessageTypes.SW2CS_ROOM_JOINED:
      enterRoom();
      break;
    case MessageTypes.SW2CS_REMOTE_UPDATE:
      handleRemoteUpdate(serviceWorkerMessage);
      break;
    case MessageTypes.SW2CS_ROOM_DISCONNECT:
      leaveRoom();
      break;
    default:
      log("Invalid BackgroundMessageType: " + serviceWorkerMessage.type);
  }
}

function findPlayer(): HTMLVideoElement | undefined {
  const player =
    document.getElementById("player0") ||
    document.getElementById("bitmovinplayer-video-null");
  return player instanceof HTMLVideoElement ? player : undefined;
}

function bindPlayer(player: HTMLVideoElement): void {
  const replacedPlayer = g_player !== undefined;
  g_player = player;
  g_lastFrameProgress = undefined;

  if (replacedPlayer && g_inRoom) {
    // Bring the new player to the room's state before its own startup events are sent
    g_awaitingResync = true;
    postToServiceWorker({ type: MessageTypes.CS2SW_REQUEST_RESYNC });
  }

  for (const action of getEnumKeys(Actions)) {
    player.addEventListener(Actions[action], handleLocalAction(Actions[action]));
  }
}

function runContentScript() {
  const player = findPlayer();

  // The player element can be replaced (next episode, ads), so keep watching for a new one
  if (player && player !== g_player) {
    log("Binding to player", player);
    bindPlayer(player);

    // Only frames that contain the player talk to the Service Worker
    if (!g_hasConnected) {
      connectPort();
    }
  }

  setTimeout(runContentScript, g_player ? 1000 : 500);
}

extensionAPI.runtime.onMessage.addListener((message: Message) => {
  // Sent by a restarted Service Worker that needs this page again (e.g. Create Room was clicked)
  if (message.type === MessageTypes.SW2CS_RECONNECT && g_player) {
    connectPort();
  }
});

runContentScript();
