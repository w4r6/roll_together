# Roll Together

Roll Together is now organized as an npm workspace monorepo containing the browser extension and its sync backend.

## Structure

- `apps/extension` - Chrome/Firefox browser extension
- `apps/backend` - Express and Socket.IO sync backend

## Setup

```bash
npm install
```

## Common Commands

```bash
npm run build
npm run build:chrome
npm run build:firefox
npm run build:backend
npm run start:backend:dev
```

Extension build outputs are written under `apps/extension/build` and `apps/extension/build-firefox`.

## DigitalOcean Deployment

The backend is configured for DigitalOcean App Platform with `.do/app.yaml`.

1. Create a DigitalOcean API token.
2. Add it to this GitHub repository as `DIGITALOCEAN_ACCESS_TOKEN`.
3. Push to `main` or run the `Deploy Backend to DigitalOcean` workflow manually.

The production extension config currently points to `https://roll-together-backend-weubw.ondigitalocean.app`.

## App Docs

- Extension details: `apps/extension/README.md`
- Backend source: `apps/backend`
