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

const JOIN_NOTIFICATION_DURATION_MS = 4_500;

let port: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 250;
let player: HTMLVideoElement | undefined;
let joinedRoomId = getRoomIdFromUrl(window.location.href);
let joinAudioContext: AudioContext | undefined;
let notificationHost: HTMLElement | undefined;
let notificationStack: HTMLElement | undefined;
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
document.addEventListener("fullscreenchange", mountNotificationHost);

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

  if (message.type === "room:member-joined") {
    showJoinNotification(message.username);
    void playJoinSound();
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

function showJoinNotification(username: string): void {
  const stack = getNotificationStack();
  const toast = document.createElement("div");
  toast.className = "joinToast";
  toast.setAttribute("role", "status");

  const icon = document.createElement("span");
  icon.className = "joinIcon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "+";

  const copy = document.createElement("span");
  copy.className = "joinCopy";
  const name = document.createElement("strong");
  name.textContent = username;
  copy.append(name, document.createTextNode(" joined the room"));

  toast.append(icon, copy);
  stack.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("joinToastLeaving");
    setTimeout(() => toast.remove(), 180);
  }, JOIN_NOTIFICATION_DURATION_MS);
}

function getNotificationStack(): HTMLElement {
  if (notificationStack?.isConnected) return notificationStack;

  const host = document.createElement("div");
  host.id = "roll-together-notifications";
  Object.assign(host.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    zIndex: "2147483647",
    pointerEvents: "none",
  });

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .joinStack {
      display: flex;
      width: min(320px, calc(100vw - 32px));
      flex-direction: column;
      gap: 10px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .joinToast {
      position: relative;
      display: grid;
      grid-template-columns: 36px minmax(0, 1fr);
      align-items: center;
      gap: 11px;
      min-height: 64px;
      padding: 12px 16px 12px 12px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 10px;
      color: #fff;
      background: rgba(28, 29, 32, 0.96);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.34);
      font-size: 14px;
      line-height: 1.35;
      animation: joinToastIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
      backdrop-filter: blur(12px);
    }

    .joinToast::after {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 3px;
      background: #f78c25;
      content: "";
      transform-origin: left;
      animation: joinToastTimer ${JOIN_NOTIFICATION_DURATION_MS}ms linear both;
    }

    .joinToastLeaving {
      opacity: 0;
      transform: translateX(12px);
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .joinIcon {
      display: grid;
      width: 36px;
      height: 36px;
      place-items: center;
      border: 1px solid rgba(247, 140, 37, 0.55);
      border-radius: 50%;
      color: #ffd1a3;
      background: rgba(247, 140, 37, 0.15);
      font-size: 23px;
      font-weight: 300;
      line-height: 1;
    }

    .joinCopy {
      overflow-wrap: anywhere;
    }

    .joinCopy strong {
      color: #ffad5e;
      font-weight: 700;
    }

    @keyframes joinToastIn {
      from {
        opacity: 0;
        transform: translate3d(18px, -5px, 0) scale(0.97);
      }
    }

    @keyframes joinToastTimer {
      to { transform: scaleX(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .joinToast,
      .joinToast::after {
        animation: none;
      }
    }
  `;

  const stack = document.createElement("div");
  stack.className = "joinStack";
  stack.setAttribute("aria-live", "polite");
  stack.setAttribute("aria-atomic", "false");
  shadow.append(style, stack);
  notificationHost = host;
  notificationStack = stack;
  mountNotificationHost();
  return stack;
}

function mountNotificationHost(): void {
  if (!notificationHost) return;

  // The browser's fullscreen top layer only renders the fullscreen element
  // and its descendants, so keep the toast inside the player while it is
  // fullscreen and return it to the page root after fullscreen closes.
  const mountTarget = document.fullscreenElement ?? document.documentElement;
  if (notificationHost.parentElement !== mountTarget) {
    mountTarget.appendChild(notificationHost);
  }
}

async function playJoinSound(): Promise<void> {
  try {
    joinAudioContext ??= new AudioContext();
    if (joinAudioContext.state === "suspended") {
      await joinAudioContext.resume();
    }

    const now = joinAudioContext.currentTime;
    playTone(joinAudioContext, 659.25, now, 0.28, 0.09);
    playTone(joinAudioContext, 987.77, now + 0.12, 0.36, 0.07);
  } catch (error: unknown) {
    log("Could not play join notification", error);
  }
}

function playTone(
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  volume: number,
): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration);
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
