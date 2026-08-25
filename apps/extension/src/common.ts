import { normalizeUsername } from "@roll-together/protocol";

import { getActionApi, getSyncStorage, setSyncStorage } from "./extension-api";
import type { StorageData } from "./types";

declare const process: { env: { NODE_ENV?: string } };

const DEFAULT_COLOR = "#F78C25";
export const SYNC_TOLERANCE_SECONDS = 2;
export const ROOM_QUERY_PARAMETER = "rollTogetherRoom";

const USERNAME_ADJECTIVES = [
  "Amber",
  "Brave",
  "Calm",
  "Cosmic",
  "Lucky",
  "Mellow",
  "Quiet",
  "Swift",
];
const USERNAME_NOUNS = [
  "Badger",
  "Crane",
  "Fox",
  "Moth",
  "Otter",
  "Panda",
  "Raven",
  "Tiger",
];
const DEBUG = process.env.NODE_ENV === "development";

export function log(...values: unknown[]): void {
  if (DEBUG) console.debug("[Roll Together]", ...values);
}

export function getRoomIdFromUrl(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get(ROOM_QUERY_PARAMETER) ?? undefined;
  } catch {
    return undefined;
  }
}

export function addRoomIdToUrl(url: string, roomId: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(ROOM_QUERY_PARAMETER, roomId);
  return parsed.toString();
}

export async function getOrCreateUsername(): Promise<string> {
  const data = await getSyncStorage<StorageData>({});
  const existing = normalizeUsername(data.username);
  if (existing) return existing;

  const username = generateUsername();
  await setSyncStorage({ username });
  return username;
}

export async function updateActionIcon(): Promise<void> {
  const canvas = new OffscreenCanvas(128, 128);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create icon canvas context");

  drawIcon(canvas, context, DEFAULT_COLOR);
  getActionApi().setIcon({ imageData: context.getImageData(0, 0, 128, 128) });
}

function generateUsername(): string {
  const adjective =
    USERNAME_ADJECTIVES[randomIndex(USERNAME_ADJECTIVES.length)];
  const noun = USERNAME_NOUNS[randomIndex(USERNAME_NOUNS.length)];
  const number = 10 + randomIndex(90);
  return `${adjective} ${noun} ${number}`;
}

function randomIndex(length: number): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return (random[0] ?? 0) % length;
}

function drawIcon(
  canvas: OffscreenCanvas,
  context: OffscreenCanvasRenderingContext2D,
  color: string,
): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  roundedRectangle(context, 4, 4, 120, 120, 24);
  context.fill();

  context.fillStyle = "#FFFFFF";
  context.font = "700 54px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("RT", 64, 68);
}

function roundedRectangle(
  context: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(
    x + width,
    y + height,
    x + width - radius,
    y + height,
  );
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}
