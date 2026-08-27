import {
  MAX_VIDEO_PROGRESS_SECONDS,
  type PlaybackUpdate,
  type RoomSnapshot,
} from "@roll-together/protocol";

import {
  getRoomIdFromUrl,
  ROOM_QUERY_PARAMETER,
  SYNC_TOLERANCE_SECONDS,
} from "./common";
import {
  createDiagnosticLogger,
  installGlobalDiagnosticHandlers,
} from "./diagnostics";
import {
  PortName,
  type BackgroundToContentMessage,
  type ContentToBackgroundMessage,
} from "./types";

type PlaybackEvent = "pause" | "play" | "seeked";
type MembershipEvent = "joined" | "left";

const JOIN_NOTIFICATION_DURATION_MS = 4_500;
const TRANSIENT_PAUSE_GRACE_MS = 250;

let port: chrome.runtime.Port | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelayMs = 250;
let player: HTMLVideoElement | undefined;
let playerHasBeenReady = false;
let playerMissingLogged = false;
let joinedRoomId = getRoomIdFromUrl(window.location.href);
let latestRoomSnapshot: RoomSnapshot | undefined;
let latestRoomSnapshotReceivedAtMs = 0;
let pendingRoomSnapshot: RoomSnapshot | undefined;
let queuedRoomSnapshot: RoomSnapshot | undefined;
let snapshotApplyInProgress = false;
let playerReadyTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPauseTimer: ReturnType<typeof setTimeout> | undefined;
let notificationAudioContext: AudioContext | undefined;
let notificationHost: HTMLElement | undefined;
let notificationStack: HTMLElement | undefined;
const suppressedEvents = new Set<PlaybackEvent>();
const playbackEvents: ReadonlyArray<PlaybackEvent> = [
  "play",
  "pause",
  "seeked",
];
const log = createDiagnosticLogger("content_script");
installGlobalDiagnosticHandlers(log);

const playerObserver = new MutationObserver(() => attachBestPlayer());
playerObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
});

connectPort();
attachBestPlayer();
document.addEventListener("fullscreenchange", mountNotificationHost);
log(
  "content_script_loaded",
  {
    url: window.location.href,
    roomId: joinedRoomId,
    visibilityState: document.visibilityState,
  },
  "info",
);

function connectPort(): void {
  if (port) return;

  const nextPort = chrome.runtime.connect({ name: PortName.CONTENT });
  port = nextPort;
  reconnectDelayMs = 250;
  log("service_worker_port_connected");

  nextPort.onMessage.addListener((value: unknown) => {
    handleBackgroundMessage(value as BackgroundToContentMessage);
  });
  nextPort.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === nextPort) port = undefined;
    log("service_worker_port_disconnected", { reconnectDelayMs }, "warn");
    scheduleReconnect();
  });

  announceReady();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  log("service_worker_reconnect_scheduled", { reconnectDelayMs });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectPort();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
}

function attachBestPlayer(): void {
  if (player?.isConnected) return;

  if (player) removePlayerListeners(player);
  if (playerReadyTimer) clearTimeout(playerReadyTimer);
  playerReadyTimer = undefined;
  playerHasBeenReady = false;
  player = findBestPlayer();
  if (!player) {
    if (!playerMissingLogged) {
      playerMissingLogged = true;
      log("video_player_not_found", {
        videoElementCount: document.querySelectorAll("video").length,
      });
    }
    return;
  }
  playerMissingLogged = false;

  for (const event of playbackEvents) {
    player.addEventListener(event, handleLocalPlayback);
  }
  player.addEventListener("canplay", handlePlayerCanPlay);
  playerHasBeenReady = player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
  log("video_player_attached", {
    width: player.clientWidth,
    height: player.clientHeight,
    readyState: player.readyState,
    playback: currentPlayback(),
  });
  if (playerHasBeenReady) applyPendingRoomSnapshot();
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
  video.removeEventListener("canplay", handlePlayerCanPlay);
}

function handleLocalPlayback(event: Event): void {
  const eventName = event.type as PlaybackEvent;
  if (suppressedEvents.delete(eventName)) {
    log("local_playback_event_suppressed", { eventName });
    return;
  }

  if (eventName === "pause") {
    schedulePauseUpdate();
    return;
  }

  cancelPendingPauseUpdate();

  const playback = currentPlayback();
  if (playback) {
    log("local_playback_changed", { eventName, playback });
    postMessage({ type: "playback:update", playback });
  }
}

function schedulePauseUpdate(): void {
  cancelPendingPauseUpdate();
  log("local_pause_update_deferred", {
    gracePeriodMs: TRANSIENT_PAUSE_GRACE_MS,
    playback: currentPlayback(),
  });
  pendingPauseTimer = setTimeout(() => {
    pendingPauseTimer = undefined;
    const playback = currentPlayback();
    if (!playback || playback.state !== "paused") return;
    log("local_playback_changed", { eventName: "pause", playback });
    postMessage({ type: "playback:update", playback });
  }, TRANSIENT_PAUSE_GRACE_MS);
}

function cancelPendingPauseUpdate(): void {
  if (!pendingPauseTimer) return;
  clearTimeout(pendingPauseTimer);
  pendingPauseTimer = undefined;
  log("local_pause_update_cancelled");
}

function handlePlayerCanPlay(): void {
  if (playerHasBeenReady) return;
  if (playerReadyTimer) clearTimeout(playerReadyTimer);
  log("video_player_can_play", { playback: currentPlayback() });
  // Let Crunchyroll's own canplay/resume handlers finish before seeking to the
  // room position. Seeking earlier can leave its stream controller stalled.
  playerReadyTimer = setTimeout(() => {
    playerReadyTimer = undefined;
    playerHasBeenReady = true;
    applyPendingRoomSnapshot();
  }, 100);
}

function applyPendingRoomSnapshot(): void {
  if (!pendingRoomSnapshot) return;
  pendingRoomSnapshot = undefined;
  const snapshot = latestRoomSnapshotAtCurrentTime();
  if (snapshot) queueRoomSnapshot(snapshot);
}

function queueRoomSnapshot(snapshot: RoomSnapshot): void {
  queuedRoomSnapshot = snapshot;
  if (!snapshotApplyInProgress) void drainRoomSnapshotQueue();
}

async function drainRoomSnapshotQueue(): Promise<void> {
  snapshotApplyInProgress = true;
  try {
    while (queuedRoomSnapshot) {
      const snapshot = queuedRoomSnapshot;
      queuedRoomSnapshot = undefined;
      await applySnapshot(snapshot);
      postMessage({
        type: "room:snapshot-applied",
        revision: snapshot.revision,
      });
    }
  } finally {
    snapshotApplyInProgress = false;
    if (queuedRoomSnapshot) void drainRoomSnapshotQueue();
  }
}

function announceReady(): void {
  const playback = currentPlayback();
  if (!playback) return;
  log("content_ready_announced", { roomId: joinedRoomId, playback });
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
    latestRoomSnapshot = message.snapshot;
    latestRoomSnapshotReceivedAtMs = Date.now();
    log("room_snapshot_received", {
      roomId: message.snapshot.roomId,
      episodePath: message.snapshot.episodePath,
      revision: message.snapshot.revision,
      state: message.snapshot.state,
      progress: message.snapshot.progress,
      memberCount: message.snapshot.members.length,
    });
    if (!playerHasBeenReady) {
      pendingRoomSnapshot = message.snapshot;
      log("room_snapshot_deferred_until_player_ready", {
        revision: message.snapshot.revision,
        readyState: player?.readyState,
      });
    } else {
      queueRoomSnapshot(message.snapshot);
    }
    return;
  }

  if (message.type === "room:member-joined") {
    showMembershipNotification(message.username, "joined");
    void playMembershipSound("joined");
    return;
  }

  if (message.type === "room:member-left") {
    showMembershipNotification(message.username, "left");
    void playMembershipSound("left");
    return;
  }

  if (message.type === "room:disconnected") {
    log("room_disconnected", { roomId: joinedRoomId }, "info");
    joinedRoomId = undefined;
    latestRoomSnapshot = undefined;
    pendingRoomSnapshot = undefined;
    queuedRoomSnapshot = undefined;
    cancelPendingPauseUpdate();
    suppressedEvents.clear();
    removeRoomIdFromAddressBar();
    return;
  }

  if (message.type === "room:error") {
    log("room_error_received", { message: message.message }, "warn");
  }
}

function latestRoomSnapshotAtCurrentTime(): RoomSnapshot | undefined {
  if (!latestRoomSnapshot || latestRoomSnapshot.state !== "playing") {
    return latestRoomSnapshot;
  }

  const elapsedSeconds = Math.max(
    0,
    (Date.now() - latestRoomSnapshotReceivedAtMs) / 1_000,
  );
  return {
    ...latestRoomSnapshot,
    progress: Math.min(
      latestRoomSnapshot.progress + elapsedSeconds,
      MAX_VIDEO_PROGRESS_SECONDS,
    ),
  };
}

function showMembershipNotification(
  username: string,
  event: MembershipEvent,
): void {
  const stack = getNotificationStack();
  const toast = document.createElement("div");
  toast.className = `memberToast memberToast${event === "joined" ? "Joined" : "Left"}`;
  toast.setAttribute("role", "status");

  const icon = document.createElement("span");
  icon.className = "memberIcon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = event === "joined" ? "+" : "−";

  const copy = document.createElement("span");
  copy.className = "memberCopy";
  const name = document.createElement("strong");
  name.textContent = username;
  copy.append(
    name,
    document.createTextNode(
      event === "joined" ? " joined the room" : " disconnected",
    ),
  );

  toast.append(icon, copy);
  stack.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("memberToastLeaving");
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

    .memberToast {
      --notification-accent: #f78c25;
      --notification-accent-text: #ffad5e;
      --notification-accent-soft: rgba(247, 140, 37, 0.15);
      --notification-accent-border: rgba(247, 140, 37, 0.55);
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
      animation: memberToastIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
      backdrop-filter: blur(12px);
    }

    .memberToastLeft {
      --notification-accent: #f06b64;
      --notification-accent-text: #ffaaa5;
      --notification-accent-soft: rgba(240, 107, 100, 0.14);
      --notification-accent-border: rgba(240, 107, 100, 0.5);
    }

    .memberToast::after {
      position: absolute;
      right: 0;
      bottom: 0;
      left: 0;
      height: 3px;
      background: var(--notification-accent);
      content: "";
      transform-origin: left;
      animation: memberToastTimer ${JOIN_NOTIFICATION_DURATION_MS}ms linear both;
    }

    .memberToastLeaving {
      opacity: 0;
      transform: translateX(12px);
      transition: opacity 160ms ease, transform 160ms ease;
    }

    .memberIcon {
      display: grid;
      width: 36px;
      height: 36px;
      place-items: center;
      border: 1px solid var(--notification-accent-border);
      border-radius: 50%;
      color: var(--notification-accent-text);
      background: var(--notification-accent-soft);
      font-size: 23px;
      font-weight: 300;
      line-height: 1;
    }

    .memberCopy {
      overflow-wrap: anywhere;
    }

    .memberCopy strong {
      color: var(--notification-accent-text);
      font-weight: 700;
    }

    @keyframes memberToastIn {
      from {
        opacity: 0;
        transform: translate3d(18px, -5px, 0) scale(0.97);
      }
    }

    @keyframes memberToastTimer {
      to { transform: scaleX(0); }
    }

    @media (prefers-reduced-motion: reduce) {
      .memberToast,
      .memberToast::after {
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

async function playMembershipSound(event: MembershipEvent): Promise<void> {
  try {
    notificationAudioContext ??= new AudioContext();
    if (notificationAudioContext.state === "suspended") {
      await notificationAudioContext.resume();
    }

    const now = notificationAudioContext.currentTime;
    if (event === "joined") {
      playTone(notificationAudioContext, 659.25, now, 0.28, 0.09);
      playTone(notificationAudioContext, 987.77, now + 0.12, 0.36, 0.07);
    } else {
      playTone(notificationAudioContext, 783.99, now, 0.28, 0.07);
      playTone(notificationAudioContext, 523.25, now + 0.12, 0.36, 0.08);
    }
  } catch (error: unknown) {
    log("membership_sound_failed", { event, error }, "warn");
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
  if (!player) {
    log(
      "snapshot_apply_skipped_without_player",
      {
        roomId: snapshot.roomId,
        revision: snapshot.revision,
      },
      "warn",
    );
    return;
  }

  const activePlayer = player;
  if (snapshot.state === "paused" && !activePlayer.paused) {
    log("playback_pause_applied", {
      roomId: snapshot.roomId,
      revision: snapshot.revision,
    });
    suppressedEvents.add("pause");
    activePlayer.pause();
  }

  const driftSeconds = activePlayer.currentTime - snapshot.progress;
  if (Math.abs(driftSeconds) > SYNC_TOLERANCE_SECONDS) {
    log("playback_seek_applied", {
      roomId: snapshot.roomId,
      revision: snapshot.revision,
      fromProgress: activePlayer.currentTime,
      toProgress: snapshot.progress,
      driftSeconds,
    });
    await seekPlayer(activePlayer, snapshot.progress, driftSeconds);
  }

  if (
    latestRoomSnapshot?.roomId !== snapshot.roomId ||
    latestRoomSnapshot.revision !== snapshot.revision
  ) {
    log("snapshot_apply_superseded", {
      roomId: snapshot.roomId,
      revision: snapshot.revision,
      latestRevision: latestRoomSnapshot?.revision,
    });
    return;
  }

  if (snapshot.state === "paused") return;

  if (snapshot.state === "playing" && activePlayer.paused) {
    log("playback_play_applied", {
      roomId: snapshot.roomId,
      revision: snapshot.revision,
    });
    suppressedEvents.add("play");
    try {
      await activePlayer.play();
    } catch (error: unknown) {
      suppressedEvents.delete("play");
      log("synchronized_playback_blocked", { error }, "error");
    }
  }
}

async function seekPlayer(
  video: HTMLVideoElement,
  progress: number,
  driftSeconds: number,
): Promise<void> {
  suppressedEvents.add("seeked");

  const seekCompleted = new Promise<boolean>((resolve) => {
    const handleSeeked = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      video.removeEventListener("seeked", handleSeeked);
      resolve(false);
    }, 5_000);
    video.addEventListener("seeked", handleSeeked, { once: true });

    try {
      video.currentTime = progress;
    } catch (error: unknown) {
      clearTimeout(timeout);
      video.removeEventListener("seeked", handleSeeked);
      suppressedEvents.delete("seeked");
      log("playback_seek_failed", { error, driftSeconds }, "error");
      resolve(false);
    }
  });

  if (await seekCompleted) return;
  suppressedEvents.delete("seeked");
  log(
    "playback_seek_timed_out",
    {
      driftSeconds,
      currentTime: video.currentTime,
      readyState: video.readyState,
      networkState: video.networkState,
    },
    "warn",
  );
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
    log(
      "service_worker_message_failed",
      { messageType: message.type, error },
      "error",
    );
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
    log("room_parameter_removal_failed", { error }, "warn");
  }
}
