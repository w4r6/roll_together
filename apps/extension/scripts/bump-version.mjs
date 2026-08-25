import { readFile, writeFile } from "node:fs/promises";

const manifestUrl = new URL("../manifest.base.json", import.meta.url);
const releaseType = process.argv[2] ?? "patch";

if (!["major", "minor", "patch"].includes(releaseType)) {
  throw new Error("Usage: npm run version:bump -- [major|minor|patch]");
}

const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const parts = manifest.version.split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) {
  throw new Error(`Invalid manifest version: ${manifest.version}`);
}

let [major, minor, patch] = parts;
if (releaseType === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (releaseType === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}

manifest.version = `${major}.${minor}.${patch}`;
await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.version);
