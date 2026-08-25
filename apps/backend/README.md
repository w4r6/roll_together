# Roll Together backend

The backend keeps short-lived playback rooms in memory and relays validated playback updates over WebSocket-only Socket.IO connections.

From the repository root:

```bash
npm run start:backend:dev
npm run test -w roll_together_backend
npm run build:backend
```

## Runtime configuration

- `PORT` — listening port; defaults to `3000`
- `NODE_ENV` — set to `production` in deployment
- `ROLL_TOGETHER_ALLOWED_ORIGINS` — optional comma-separated exact origin allowlist

Rooms intentionally disappear when their last viewer leaves or the process restarts. The deployment therefore stays at one instance. A multi-instance deployment would require a shared Socket.IO adapter and room store.

`GET /health` reports process health plus current connection and room counts. The server validates handshakes and playback updates, limits message size and update frequency, and shuts down cleanly on `SIGTERM` or `SIGINT`.
