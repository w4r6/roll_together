import {
  MAX_USERNAME_LENGTH,
  normalizeUsername,
} from "@roll-together/protocol";

import { getOrCreateUsername } from "./common";
import { setSyncStorage } from "./extension-api";

const profileStatus = element("profileStatus");
const profileForm = form("profileForm");
const usernameInput = input("usernameInput");

profileForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveUsername();
});

void initialize();

async function initialize(): Promise<void> {
  try {
    usernameInput.value = await getOrCreateUsername();
  } catch (error: unknown) {
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
    showStatus("Username saved.");
  } catch (error: unknown) {
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
