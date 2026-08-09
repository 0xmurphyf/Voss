# VOSS Protocol v2.6

A terminal-style, NFT-gated interactive narrative and executive-selection simulation.

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

The app verifies wallet signatures and reuses the Voxxstake ownership scan,
including direct holdings and unlisted Kiosk holdings. Set the optional
`VOXXSTAKE_API_URL` variable when the staking API is not hosted at the default:

```text
https://voxx.up.railway.app/api
```

Only a wallet with a currently owned VOXX NFT may begin. The selected NFT's
number becomes the candidate number throughout the simulation.
