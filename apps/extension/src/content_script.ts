import {
  MAX_VIDEO_PROGRESS_SECONDS,
  type PlaybackUpdate,
  type RoomSnapshot,
} from "@roll-together/protocol";

import {
  getRoomIdFromUrl,
  log,
  ROOM_QUERY_PARAMETER,
  SYNC_TOLERANCE_SECONDS,
} from "./common";
import {
  PortName,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
} from "./types";

type PlaybackEvent = "pause" | "play" | "seeked";

let port: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 250;
let player: HTMLVideoElement | undefined;
let joinedRoomId = getRoomIdFromUrl(window.location.href);
const suppressedEvents = new Set<PlaybackEvent>();
const playbackEvents: ReadonlyArray<PlaybackEvent> = [
  "play",
  "pause",
  "seeked",
];

const playerObserver = new MutationObserver(() => attachBestPlayer());
playerObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

connectPort();
attachBestPlayer();

function connectPort(): void {
  if (port) return;

  const nextPort = chrome.runtime.connect({ name: PortName.CONTENT });
  port = nextPort;
  reconnectDelayMs = 250;

  nextPort.onMessage.addListener((value: unknown) => {
    handleBackgroundMessage(value as BackgroundToContentMessage);
  });
  nextPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === nextPort) port = undefined;
    scheduleReconnect();
  });

  announceReady();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectPort();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
}

function attachBestPlayer(): void {
  if (player?.isConnected) return;

  if (player) removePlayerListeners(player);
  player = findBestPlayer();
  if (!player) return;

  for (const event of playbackEvents) {
    player.addEventListener(event, handleLocalPlayback);
  }
  announceReady();
}

function findBestPlayer(): HTMLVideoElement | undefined {
  const candidates = Array.from(document.querySelectorAll("video"));
  return candidates.sort(
    (left, right) =>
      right.clientWidth * right.clientHeight -
      left.clientWidth * left.clientHeight,
  )[0];
}

function removePlayerListeners(video: HTMLVideoElement): void {
  for (const event of playbackEvents) {
    video.removeEventListener(event, handleLocalPlayback);
  }
}

function handleLocalPlayback(event: Event): void {
  const eventName = event.type as PlaybackEvent;
  if (suppressedEvents.delete(eventName)) return;

  const playback = currentPlayback();
  if (playback) postMessage({ type: "playback:update", playback });
}

function announceReady(): void {
  const playback = currentPlayback();
  if (!playback) return;
  postMessage(
    joinedRoomId
      ? { type: "content:ready", playback, roomId: joinedRoomId }
      : { type: "content:ready", playback },
  );
}

function handleBackgroundMessage(message: BackgroundToContentMessage): void {
  if (message.type === "room:connect-request") {
    const playback = currentPlayback();
    if (!playback) return;
    postMessage(
      message.roomId
        ? { type: "room:connect", playback, roomId: message.roomId }
        : { type: "room:connect", playback },
    );
    return;
  }

  if (message.type === "room:snapshot") {
    joinedRoomId = message.snapshot.roomId;
    void applySnapshot(message.snapshot);
    return;
  }

  if (message.type === "room:disconnected") {
    joinedRoomId = undefined;
    suppressedEvents.clear();
    removeRoomIdFromAddressBar();
    return;
  }

  if (message.type === "room:error") log(message.message);
}

async function applySnapshot(snapshot: RoomSnapshot): Promise<void> {
  if (!player) return;

  if (
    Math.abs(player.currentTime - snapshot.progress) > SYNC_TOLERANCE_SECONDS
  ) {
    suppressedEvents.add("seeked");
    try {
      player.currentTime = snapshot.progress;
    } catch (error: unknown) {
      suppressedEvents.delete("seeked");
      log("Could not seek video", error);
    }
  }

  if (snapshot.state === "paused" && !player.paused) {
    suppressedEvents.add("pause");
    player.pause();
    return;
  }

  if (snapshot.state === "playing" && player.paused) {
    suppressedEvents.add("play");
    try {
      await player.play();
    } catch (error: unknown) {
      suppressedEvents.delete("play");
      log("Browser blocked synchronized playback", error);
    }
  }
}

function currentPlayback(): PlaybackUpdate | undefined {
  if (!player) return undefined;
  const progress = Number.isFinite(player.currentTime)
    ? Math.min(Math.max(player.currentTime, 0), MAX_VIDEO_PROGRESS_SECONDS)
    : 0;
  return { state: player.paused ? "paused" : "playing", progress };
}

function postMessage(message: ContentToBackgroundMessage): void {
  if (!port) return;
  try {
    port.postMessage(message);
  } catch (error: unknown) {
    log("Could not reach service worker", error);
    port = undefined;
    scheduleReconnect();
  }
}

function removeRoomIdFromAddressBar(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(ROOM_QUERY_PARAMETER)) return;
    url.searchParams.delete(ROOM_QUERY_PARAMETER);
    window.history.replaceState(window.history.state, "", url.toString());
  } catch (error: unknown) {
    log("Could not remove room from URL", error);
  }
}
