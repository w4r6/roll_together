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

const ignoreNext: { [index: string]: boolean } = {};
let g_port: chrome.runtime.Port | undefined = undefined;
let g_player: HTMLVideoElement | undefined = undefined;
let g_lastFrameProgress: number | undefined = undefined;
let g_heartBeatInterval: NodeJS.Timeout | undefined = undefined; // Keeps Service Worker alive while connected
let g_reconnectTimeout: NodeJS.Timeout | undefined = undefined;
let g_pendingMessages: Message[] = [];
let g_playPromise: Promise<void> | undefined = undefined;

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

  g_lastFrameProgress = g_lastFrameProgress || currentProgress;

  const timeJump: boolean =
    Math.abs(currentProgress - g_lastFrameProgress) > LIMIT_DELTA_TIME;
  const state: States = paused ? States.PAUSED : States.PLAYING;

  g_lastFrameProgress = currentProgress;
  return { state, currentProgress, timeJump };
}

const handleLocalAction = (action: Actions) => (): void => {
  if (ignoreNext[action] === true) {
    ignoreNext[action] = false;
    return;
  }

  const {
    state,
    currentProgress,
    timeJump,
  }: { state: States; currentProgress: number; timeJump: boolean } =
    getStates();
  const type = MessageTypes.CS2SW_LOCAL_UPDATE;

  log("Local Action", action, { type, state, currentProgress, timeJump });
  switch (action) {
    case Actions.PLAY:
    case Actions.PAUSE:
      postServiceWorkerMessage({ type, state, currentProgress });
      break;
    case Actions.TIME_UPDATE:
      if (timeJump) {
        postServiceWorkerMessage({ type, state, currentProgress });
      }
      break;
  }
};

function triggerAction(action: Actions, progress: number): void {
  if (_.isNil(g_player)) {
    log("Player is Undefined so no action will be triggered");
    return;
  }
  ignoreNext[action] = true;

  switch (action) {
    case Actions.PAUSE:
      if (g_playPromise) {
        g_playPromise.then(() => {
          g_player!.pause();
          g_player!.currentTime = progress;
        }).catch(_.noop);
        g_playPromise = undefined;
      } else {
        g_player.pause();
        g_player.currentTime = progress;
      }
      break;
    case Actions.PLAY:
      g_playPromise = g_player.play();
      g_playPromise.catch(_.noop);
      if (Math.abs(g_player.currentTime - progress) > LIMIT_DELTA_TIME) {
        g_player.currentTime = progress;
      }
      break;
    case Actions.TIME_UPDATE:
      g_player.currentTime = progress;
      break;
    default:
      ignoreNext[action] = false;
  }
}

function sendRoomConnectionMessage(): void {
  const { state, currentProgress }: { state: States; currentProgress: number } =
    getStates();
  const type = MessageTypes.CS2SW_ROOM_CONNECTION;
  postServiceWorkerMessage({ state, currentProgress, type });
}

function handleRemoteUpdate(message: Message): void {
  if (message.type != MessageTypes.SW2CS_REMOTE_UPDATE) {
    throw "Invalid Message Type: " + message.type;
  }
  const { roomState, roomProgress } = message;
  log("Handling Remote Update", { roomState, roomProgress });

  const { state, currentProgress }: { state: States; currentProgress: number } =
    getStates();
  if (state !== roomState) {
    if (roomState === States.PAUSED) triggerAction(Actions.PAUSE, roomProgress);
    if (roomState === States.PLAYING) triggerAction(Actions.PLAY, roomProgress);
  }

  if (Math.abs(roomProgress - currentProgress) > LIMIT_DELTA_TIME) {
    triggerAction(Actions.TIME_UPDATE, roomProgress);
  }
}

function handleServiceWorkerMessage(serviceWorkerMessage: Message) {
  if (!g_player) {
    log("Player not ready, queuing message", serviceWorkerMessage);
    g_pendingMessages.push(serviceWorkerMessage);
    return;
  }

  log("Received message from Background", serviceWorkerMessage);

  switch (serviceWorkerMessage.type) {
    case MessageTypes.SW2CS_ROOM_CONNECTION:
      g_heartBeatInterval = setInterval(
        () => postServiceWorkerMessage({ type: MessageTypes.CS2SW_HEART_BEAT }),
        20000
      );
      sendRoomConnectionMessage();
      break;
    case MessageTypes.SW2CS_REMOTE_UPDATE:
      handleRemoteUpdate(serviceWorkerMessage);
      break;
    case MessageTypes.SW2CS_ROOM_DISCONNECT:
      if (g_heartBeatInterval) {
        clearInterval(g_heartBeatInterval);
      }
      break;
    default:
      throw "Invalid BackgroundMessageType: " + serviceWorkerMessage.type;
  }
}

function connectToServiceWorker(): void {
  if (g_port) {
    return;
  }

  try {
    const port = extensionAPI.runtime.connect({ name: PortName.CONTENT_SCRIPT });
    g_port = port;

    port.onMessage.addListener(handleServiceWorkerMessage);
    port.onDisconnect.addListener(() => {
      if (g_port === port) {
        g_port = undefined;
      }

      if (g_heartBeatInterval) {
        clearInterval(g_heartBeatInterval);
        g_heartBeatInterval = undefined;
      }

      scheduleServiceWorkerReconnect();
    });
  } catch (err) {
    log("Failed to connect to service worker", err);
    scheduleServiceWorkerReconnect();
  }
}

function scheduleServiceWorkerReconnect(): void {
  if (g_reconnectTimeout) {
    return;
  }

  g_reconnectTimeout = setTimeout(() => {
    g_reconnectTimeout = undefined;
    connectToServiceWorker();
  }, 1000);
}

function postServiceWorkerMessage(message: Message): void {
  connectToServiceWorker();

  if (!g_port) {
    log("No service worker port available; dropping message", message);
    return;
  }

  try {
    g_port.postMessage(message);
  } catch (err) {
    log("Failed to post message to service worker", err);
    g_port = undefined;
    scheduleServiceWorkerReconnect();
  }
}

function runContentScript() {
  g_player = (document.getElementById("player0") || document.getElementById("bitmovinplayer-video-null")) as HTMLVideoElement;

  if (!g_player) {
    setTimeout(runContentScript, 500);
    return;
  }

  for (const action of getEnumKeys(Actions)) {
    g_player.addEventListener(
      Actions[action],
      handleLocalAction(Actions[action])
    );
  }

  // Replay any messages that arrived before the player was ready
  const pending = g_pendingMessages.splice(0);
  for (const msg of pending) {
    handleServiceWorkerMessage(msg);
  }
}

connectToServiceWorker();
runContentScript();
