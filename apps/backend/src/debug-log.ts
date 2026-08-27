import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type DebugLevel = "debug" | "info" | "warn" | "error";

export interface DebugEntry {
  timestamp?: string;
  level: DebugLevel;
  source: string;
  event: string;
  contextId?: string;
  details?: unknown;
}

export interface DebugLogSink {
  readonly path?: string;
  record(entry: DebugEntry): void;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_STRING_LENGTH = 4_000;
const MAX_DEPTH = 6;

export class DevelopmentDebugLog implements DebugLogSink {
  readonly path: string;

  constructor(path = defaultDebugLogPath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path);
    this.record({
      level: "info",
      source: "backend",
      event: "debug_session_started",
      details: {
        pid: process.pid,
        nodeVersion: process.version,
        logPath: path,
      },
    });
  }

  record(entry: DebugEntry): void {
    const safeEntry = sanitize(entry, "", 0) as Record<string, unknown>;
    appendFileSync(
      this.path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...safeEntry })}\n`,
      "utf8",
    );
  }
}

export function defaultDebugLogPath(): string {
  return resolve(__dirname, "..", "..", "..", ".debug", "roll-together.jsonl");
}

export function isDebugEntry(value: unknown): value is DebugEntry {
  if (!isRecord(value)) return false;
  return (
    (value.timestamp === undefined || typeof value.timestamp === "string") &&
    isDebugLevel(value.level) &&
    typeof value.source === "string" &&
    value.source.length > 0 &&
    value.source.length <= 80 &&
    typeof value.event === "string" &&
    value.event.length > 0 &&
    value.event.length <= 120 &&
    (value.contextId === undefined ||
      (typeof value.contextId === "string" && value.contextId.length <= 80))
  );
}

function rotateIfNeeded(path: string): void {
  try {
    if (statSync(path).size < MAX_LOG_BYTES) return;
    const previousPath = `${path}.previous`;
    rmSync(previousPath, { force: true });
    renameSync(path, previousPath);
  } catch (error: unknown) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}

function sanitize(value: unknown, key: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, "message"),
      ...(value.stack ? { stack: sanitizeString(value.stack, "stack") } : {}),
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, key, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([childKey, childValue]) => [
          childKey,
          sanitize(childValue, childKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

function sanitizeString(value: string, key: string): string {
  if (/password|secret|token|authorization|cookie|username/i.test(key)) {
    return "[redacted]";
  }
  if (/roomId|socketId|episodePath/i.test(key)) {
    if (/^<[^>]+#[a-f0-9]{8}>$/.test(value)) return value;
    return fingerprint(value, key);
  }
  if (/url|filename/i.test(key)) return sanitizeUrl(value);
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const queryKeys = Array.from(url.searchParams.keys());
    url.search = "";
    url.hash = "";
    return `${url.toString()}${queryKeys.length ? `?[${queryKeys.join(",")}]` : ""}`;
  } catch {
    return value.length <= MAX_STRING_LENGTH
      ? value
      : `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
  }
}

function fingerprint(value: string, label: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `<${label}#${(hash >>> 0).toString(16).padStart(8, "0")}>`;
}

function isDebugLevel(value: unknown): value is DebugLevel {
  return (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
