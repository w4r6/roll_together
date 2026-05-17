# Roll Together Backend

Express and Socket.IO sync backend for the Roll Together browser extension.

From the repository root:

```bash
npm run build:backend
npm run start:backend:dev
```

## DigitalOcean App Platform

This service is deployed from the monorepo root using `.do/app.yaml`.

- Build command: `npm ci && npm run build:backend`
- Run command: `npm run start:prod -w roll_together_backend`
- Health check: `/health`

GitHub Actions deploys it with `.github/workflows/deploy-digitalocean.yml` when `DIGITALOCEAN_ACCESS_TOKEN` is configured.
