import { addRoomIdToUrl, log } from "./common";
import { queryActiveTab } from "./extension-api";
import {
  PortName,
  type BackgroundToPopupMessage,
  type ConnectionStatus,
  type PopupToBackgroundMessage,
} from "./types";

const loadingPanel = element("loadingPanel");
const disconnectedPanel = element("disconnectedPanel");
const connectedPanel = element("connectedPanel");
const errorPanel = element("errorPanel");
const errorMessage = element("errorMessage");
const liveStatus = element("liveStatus");
const createRoomButton = button("createRoom");
const copyUrlButton = button("copyUrl");
const disconnectButton = button("disconnect");
const retryButton = button("retry");
const openOptionsButton = button("openOptions");
const memberCount = element("memberCount");
const memberList = element("memberList");

const port = chrome.runtime.connect({ name: PortName.POPUP });
let activeTab: chrome.tabs.Tab | undefined;
let inviteUrl = "";

port.onMessage.addListener((value: unknown) => {
  const message = value as BackgroundToPopupMessage;
  if (message.type === "popup:status") render(message.status);
});

createRoomButton.addEventListener("click", () => {
  if (activeTab?.id === undefined) return;
  createRoomButton.disabled = true;
  post({ type: "popup:create", tabId: activeTab.id });
});

copyUrlButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(inviteUrl);
    liveStatus.textContent = "Invite link copied.";
    copyUrlButton.textContent = "Copied";
    setTimeout(() => (copyUrlButton.textContent = "Copy invite link"), 1_500);
  } catch (error: unknown) {
    liveStatus.textContent = "Could not copy the invite link.";
    log("Clipboard write failed", error);
  }
});

disconnectButton.addEventListener("click", () => {
  if (activeTab?.id === undefined) return;
  post({ type: "popup:disconnect", tabId: activeTab.id });
});

retryButton.addEventListener("click", () => void initialize());
openOptionsButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

void initialize();

async function initialize(): Promise<void> {
  showPanel(loadingPanel);
  try {
    const tab = await queryActiveTab();
    activeTab = tab;

    if (tab?.id === undefined) {
      render({ state: "error", message: "No active browser tab was found." });
      return;
    }
    post({ type: "popup:status", tabId: tab.id });
  } catch (error: unknown) {
    render({
      state: "error",
      message:
        error instanceof Error
          ? error.message
          : "Could not load Roll Together.",
    });
  }
}

function render(status: ConnectionStatus): void {
  createRoomButton.disabled = false;

  if (status.state === "connecting") {
    liveStatus.textContent = "Connecting to the room.";
    showPanel(loadingPanel);
    return;
  }

  if (status.state === "connected") {
    if (!activeTab?.url) {
      render({
        state: "error",
        message: "This tab does not have a shareable URL.",
      });
      return;
    }
    inviteUrl = addRoomIdToUrl(activeTab.url, status.roomId);
    renderMembers(status.members);
    liveStatus.textContent = "Connected and ready to watch together.";
    showPanel(connectedPanel);
    return;
  }

  if (status.state === "error") {
    errorMessage.textContent = status.message;
    liveStatus.textContent = status.message;
    showPanel(errorPanel);
    return;
  }

  liveStatus.textContent = "Ready to create a room.";
  showPanel(disconnectedPanel);
}

function renderMembers(
  members: Array<{ username: string; isSelf: boolean }>,
): void {
  memberList.replaceChildren();
  memberCount.textContent = String(members.length);

  for (const member of members) {
    const item = document.createElement("li");
    item.className = "member-row";

    const avatar = document.createElement("span");
    avatar.className = "member-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.textContent = member.username.charAt(0).toUpperCase();

    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = member.username;
    if (member.isSelf) {
      const selfLabel = document.createElement("span");
      selfLabel.className = "self-label";
      selfLabel.textContent = " (me)";
      name.appendChild(selfLabel);
    }

    item.append(avatar, name);
    memberList.appendChild(item);
  }
}

function showPanel(panel: HTMLElement): void {
  for (const candidate of [
    loadingPanel,
    disconnectedPanel,
    connectedPanel,
    errorPanel,
  ]) {
    candidate.hidden = candidate !== panel;
  }
}

function post(message: PopupToBackgroundMessage): void {
  port.postMessage(message);
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function button(id: string): HTMLButtonElement {
  const value = element(id);
  if (!(value instanceof HTMLButtonElement))
    throw new Error(`#${id} is not a button`);
  return value;
}
