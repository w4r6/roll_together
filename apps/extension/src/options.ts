import {
  MAX_USERNAME_LENGTH,
  normalizeUsername,
} from "@roll-together/protocol";

import { getOrCreateUsername } from "./common";
import {
  createDiagnosticLogger,
  installGlobalDiagnosticHandlers,
} from "./diagnostics";
import { setSyncStorage } from "./extension-api";

const profileStatus = element("profileStatus");
const profileForm = form("profileForm");
const usernameInput = input("usernameInput");
const log = createDiagnosticLogger("options");
installGlobalDiagnosticHandlers(log);
log("options_loaded", undefined, "info");

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveUsername();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    usernameInput.value = await getOrCreateUsername();
  } catch (error: unknown) {
    log("username_load_failed", { error }, "error");
    showStatus(
      error instanceof Error ? error.message : "Could not load your username.",
      true,
    );
  }
}

async function saveUsername(): Promise<void> {
  const username = normalizeUsername(usernameInput.value);
  if (!username) {
    showStatus(
      `Enter a username between 1 and ${MAX_USERNAME_LENGTH} characters.`,
      true,
    );
    return;
  }

  usernameInput.value = username;
  try {
    await setSyncStorage({ username });
    log("username_saved", undefined, "info");
    showStatus("Username saved.");
  } catch (error: unknown) {
    log("username_save_failed", { error }, "error");
    showStatus(
      error instanceof Error ? error.message : "Could not save your username.",
      true,
    );
  }
}

function showStatus(message: string, error = false): void {
  profileStatus.textContent = message;
  profileStatus.dataset.tone = error ? "error" : "success";
}

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value;
}

function form(id: string): HTMLFormElement {
  const value = element(id);
  if (!(value instanceof HTMLFormElement))
    throw new Error(`#${id} is not a form`);
  return value;
}

function input(id: string): HTMLInputElement {
  const value = element(id);
  if (!(value instanceof HTMLInputElement))
    throw new Error(`#${id} is not an input`);
  return value;
}
