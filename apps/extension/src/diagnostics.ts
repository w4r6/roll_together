declare const process: {
  env: { NODE_ENV?: string; SYNC_SERVER?: string };
};

export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticEntry {
  timestamp: string;
  level: DiagnosticLevel;
  source: string;
  contextId: string;
  event: string;
  details?: unknown;
}

interface DiagnosticMessage {
  type: "diagnostics:record";
  entry: DiagnosticEntry;
}

export type DiagnosticLogger = (
  event: string,
  details?: unknown,
  level?: DiagnosticLevel,
) => void;

const DEVELOPMENT = process.env.NODE_ENV === "development";
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 30;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 5;
const contextId = crypto.randomUUID();

export function createDiagnosticLogger(
  source: string,
  sink?: (entry: DiagnosticEntry) => void,
): DiagnosticLogger {
  return (event, details, level = "debug") => {
    if (!DEVELOPMENT) return;

    const entry: DiagnosticEntry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      contextId,
      event,
      ...(details === undefined ? {} : { details: sanitize(details) }),
    };

    writeToConsole(entry);
    if (sink) {
      sink(entry);
      return;
    }

    const message: DiagnosticMessage = { type: "diagnostics:record", entry };
    void chrome.runtime.sendMessage(message).catch(() => {
      // The console entry remains available if the service worker is restarting.
    });
  };
}

export function isDiagnosticMessage(
  value: unknown,
): value is DiagnosticMessage {
  if (!isRecord(value) || value.type !== "diagnostics:record") return false;
  const entry = value.entry;
  return (
    isRecord(entry) &&
    typeof entry.timestamp === "string" &&
    isDiagnosticLevel(entry.level) &&
    typeof entry.source === "string" &&
    typeof entry.contextId === "string" &&
    typeof entry.event === "string"
  );
}

export function installGlobalDiagnosticHandlers(log: DiagnosticLogger): void {
  globalThis.addEventListener("error", (event: Event) => {
    const errorEvent = event as ErrorEvent;
    log(
      "uncaught_error",
      {
        message: errorEvent.message,
        filename: errorEvent.filename,
        line: errorEvent.lineno,
        column: errorEvent.colno,
        error: errorEvent.error,
      },
      "error",
    );
  });

  globalThis.addEventListener("unhandledrejection", (event: Event) => {
    log(
      "unhandled_rejection",
      { reason: (event as PromiseRejectionEvent).reason },
      "error",
    );
  });
}

export function developmentDiagnosticsUrl(): string | undefined {
  if (!DEVELOPMENT || !process.env.SYNC_SERVER) return undefined;
  return new URL("/__debug/log", process.env.SYNC_SERVER).toString();
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeString(value, key);
  if (typeof value === "function")
    return `[function ${value.name || "anonymous"}]`;
  if (typeof value === "symbol") return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message, "message"),
      ...(value.stack ? { stack: sanitizeString(value.stack, "stack") } : {}),
    };
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitize(item, key, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      items.push(`[${value.length - MAX_ARRAY_LENGTH} more items]`);
    }
    return items;
  }

  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [childKey, childValue] of entries) {
      result[childKey] = sanitize(childValue, childKey, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      result.__truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
    }
    return result;
  }

  return sanitizeString(String(value), key);
}

function sanitizeString(value: string, key: string): string {
  if (/password|secret|token|authorization|cookie|username/i.test(key)) {
    return "[redacted]";
  }
  if (/roomId|socketId|episodePath/i.test(key)) {
    return fingerprint(value, key);
  }
  if (/url|filename/i.test(key)) return sanitizeUrl(value);

  const scrubbed = value.replace(/\b[A-Za-z0-9_-]{20,64}\b/g, (match) =>
    fingerprint(match, "id"),
  );
  return truncate(scrubbed);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const queryKeys = Array.from(url.searchParams.keys());
    url.search = "";
    url.hash = "";
    return truncate(
      `${url.toString()}${queryKeys.length ? `?[${queryKeys.join(",")}]` : ""}`,
    );
  } catch {
    return truncate(value);
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

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`;
}

function writeToConsole(entry: DiagnosticEntry): void {
  const values = [
    `[Roll Together:${entry.source}]`,
    entry.event,
    ...(entry.details === undefined ? [] : [entry.details]),
  ];
  if (entry.level === "error") console.error(...values);
  else if (entry.level === "warn") console.warn(...values);
  else if (entry.level === "info") console.info(...values);
  else console.debug(...values);
}

function isDiagnosticLevel(value: unknown): value is DiagnosticLevel {
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
