# Roll Together

## Structure

- `apps/extension` - Chrome/Firefox browser extension
- `apps/backend` - Express and Socket.IO sync backend

## Setup

```bash
npm install
```

## Download

- **Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/roll-together/opfkhpijmigdkjafeenfgbndokfphamh)

## Common Commands

```bash
npm run dev
npm run build
npm run build:chrome
npm run build:firefox
npm run build:backend
npm run start:backend:dev
```

`npm run dev` starts the Chrome extension compiler in watch mode and the backend on `http://localhost:3000`. It also watches the shared protocol package, so source changes rebuild automatically. Use `npm run dev:firefox` for Firefox.

Development extension outputs are written under `apps/extension/build` and `apps/extension/build-firefox`. Production outputs are kept separately under `apps/extension/build-production` and `apps/extension/build-production-firefox`, so production checks cannot overwrite a running localhost build.

## Development diagnostics

Development runs write structured JSON Lines diagnostics to
`.debug/roll-together.jsonl`. The log combines browser-extension and backend
events in timestamp order, including connection lifecycle, room revisions,
playback drift and corrections, navigation, validation failures, and uncaught
errors. Restarting the extension or backend adds a new session marker without
discarding the previous run. At 5 MB, the current file moves to
`roll-together.jsonl.previous` and a fresh file starts.

The development logger fingerprints room IDs, socket IDs, and episode paths;
redacts usernames, credentials, cookies, and tokens; and removes URL query
values. Production extension builds do not emit diagnostics, and production
backends do not expose the local collector or create `.debug` files.

## DigitalOcean Deployment

The backend is configured for DigitalOcean App Platform with `.do/app.yaml`.

1. Create a DigitalOcean API token.
2. Add it to this GitHub repository as `DIGITALOCEAN_ACCESS_TOKEN`.
3. Push to `main` or run the `Deploy Backend to DigitalOcean` workflow manually.
