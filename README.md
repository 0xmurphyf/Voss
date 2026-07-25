# VOSS Protocol v2.6

A terminal-style interactive narrative and executive-selection simulation.

## Run locally

Requires Node.js 20 or newer.

```bash
npm start
```

Open `http://localhost:4173`.

## Deploy on Railway

Connect this repository to a Railway service. Railway detects the Node.js
application and runs `npm start`. The server listens on Railway's injected
`PORT` environment variable and serves the game from the repository root.

Add a Railway PostgreSQL service to the same project, then set this application
service's `DATABASE_URL` variable to:

```text
${{Postgres.DATABASE_URL}}
```

The server creates its counter table automatically. Candidate numbers are
allocated atomically across all browsers and devices, beginning at `#1500`.
