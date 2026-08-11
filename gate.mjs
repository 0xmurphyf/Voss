// gate.mjs — self-contained wallet gate for voss.
// Replaces the old proxy-to-voxxstake behavior with an in-process
// nonce/verify/scan flow so voss no longer depends on voxxinc.xyz for auth.
//
// - nonce:  voss generates the signing message (custom copy below).
// - verify: voss verifies the Sui signature and issues its own HS256 JWT.
// - scan:   voss queries Sui directly for owned VOXX NFTs.
//
// Nonces are stored in Postgres (table voss_gate_nonces) so the flow is
// stateless across redeploys. JWT signing uses env JWT_SECRET (required).
import { randomBytes, createHash } from "node:crypto";
import { verifySignature, getOwnedVoxxNfts } from "./suiChain.mjs";

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const NONCE_EXPIRY_SECONDS = 300;
const NONCE_TITLE = "Entering voss test";

function normalizeAddress(addr) {
  let a = String(addr || "").toLowerCase().trim();
  if (!a.startsWith("0x")) a = "0x" + a;
  return a;
}

function makeNonce(address) {
  const randomPart = randomBytes(16).toString("hex");
  return `${NONCE_TITLE}\n\nWallet: ${address}\nNonce: ${randomPart}`;
}

// ── JWT (HS256, pinned algorithm) ──────────────────────────────
// Minimal inline JWT so we avoid pulling jsonwebtoken. Node 22 has webcrypto.
import { createHmac, timingSafeEqual } from "node:crypto";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function base64urlJson(obj) {
  return base64url(JSON.stringify(obj));
}
function fromBase64url(input) {
  const pad = input.length % 4 ? 4 - (input.length % 4) : 0;
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + "====".slice(0, pad), "base64");
}

export function signGateToken(address, secret, hours = 4) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = { sub: address, iat: now, exp: now + hours * 3600 };
  const data = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyGateToken(token, secret) {
  try {
    const parts = String(token).split(".");
    if (parts.length !== 3) return null;
    const [h, p, s] = parts;
    const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
    const a = Buffer.from(s);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromBase64url(p).toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (payload.alg && payload.alg !== "HS256") return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Handlers ──────────────────────────────────────────────────
export function buildGateHandlers(pool, jwtSecret) {
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required for the voss gate. Refusing to start without it.");
  }

  async function createNonce(address) {
    const nonce = makeNonce(address);
    await pool.query(
      `INSERT INTO voss_gate_nonces (address, nonce, created_at, used)
       VALUES ($1, $2, NOW(), FALSE)
       ON CONFLICT (address) DO UPDATE
         SET nonce = EXCLUDED.nonce, created_at = NOW(), used = FALSE`,
      [address, nonce]
    );
    return nonce;
  }

  async function consumeNonce(address, nonce) {
    const res = await pool.query(
      `SELECT nonce, created_at, used FROM voss_gate_nonces WHERE address = $1`,
      [address]
    );
    if (res.rowCount === 0) return { ok: false, reason: "Invalid or already used nonce" };
    const row = res.rows[0];
    if (row.used) return { ok: false, reason: "Invalid or already used nonce" };
    if (row.nonce !== nonce) return { ok: false, reason: "Invalid or already used nonce" };
    const age = (Date.now() - new Date(row.created_at).getTime()) / 1000;
    if (age > NONCE_EXPIRY_SECONDS) {
      await pool.query(`UPDATE voss_gate_nonces SET used = TRUE WHERE address = $1`, [address]);
      return { ok: false, reason: "Nonce expired" };
    }
    return { ok: true };
  }

  async function markUsed(address) {
    await pool.query(`UPDATE voss_gate_nonces SET used = TRUE WHERE address = $1`, [address]);
  }

  return {
    async nonce(req, res) {
      try {
        const { address, purpose } = (await readBody(req)) || {};
        if (!address) {
          sendJson(res, 400, { detail: "Address is required" });
          return;
        }
        const normalized = normalizeAddress(address);
        const nonce = await createNonce(normalized);
        sendJson(res, 200, { nonce, address: normalized });
      } catch (err) {
        console.error("Gate nonce error:", err);
        sendJson(res, 500, { detail: "Failed to create nonce" });
      }
    },

    async verify(req, res) {
      try {
        const body = (await readBody(req)) || {};
        const { address, nonce, signature, bytes } = body;
        if (!address || !nonce || !signature || !bytes) {
          sendJson(res, 400, { detail: "Missing required fields" });
          return;
        }
        const normalized = normalizeAddress(address);
        const check = await consumeNonce(normalized, nonce);
        if (!check.ok) {
          sendJson(res, 400, { detail: check.reason });
          return;
        }
        // Signed message must equal the nonce string.
        let signedMsg;
        try {
          signedMsg = Buffer.from(bytes, "base64").toString("utf-8");
        } catch {
          sendJson(res, 400, { detail: "Invalid message encoding" });
          return;
        }
        if (signedMsg !== nonce) {
          sendJson(res, 400, { detail: "Signed message does not match nonce" });
          return;
        }
        const valid = await verifySignature(normalized, nonce, signature, bytes);
        if (!valid) {
          sendJson(res, 400, { detail: "Invalid signature" });
          return;
        }
        await markUsed(normalized);
        const token = signGateToken(normalized, jwtSecret);
        sendJson(res, 200, { token, address: normalized });
      } catch (err) {
        console.error("Gate verify error:", err);
        sendJson(res, 500, { detail: "Verification failed" });
      }
    },

    async scan(req, res) {
      try {
        const auth = String(req.headers.authorization || "");
        if (!auth.startsWith("Bearer ")) {
          sendJson(res, 401, { detail: "Wallet authentication required" });
          return;
        }
        const payload = verifyGateToken(auth.slice(7), jwtSecret);
        if (!payload || !payload.sub) {
          sendJson(res, 401, { detail: "Invalid or expired token" });
          return;
        }
        const address = payload.sub;
        let nfts;
        try {
          nfts = await getOwnedVoxxNfts(address);
        } catch (err) {
          console.error("Gate scan chain error:", err);
          sendJson(res, 502, { detail: "Failed to read on-chain ownership" });
          return;
        }
        // Map on-chain holdings into the shape the voss frontend expects
        // (camelCase objectId, plus local attempt status from voss_nft_attempts).
        const ids = nfts.map((n) => n.object_id);
        const attempts = ids.length
          ? await pool.query(
              "SELECT object_id, status, completed_cases FROM voss_nft_attempts WHERE object_id = ANY($1::text[])",
              [ids]
            )
          : { rows: [] };
        const attemptById = new Map(attempts.rows.map((row) => [row.object_id, row]));
        const mapped = nfts.map((nft) => {
          const attempt = attemptById.get(nft.object_id);
          const name = nft.name || `VOXX #${String(nft.object_id || "").slice(-6)}`;
          const match = name.match(/#\s*0*(\d+)/) || String(nft.object_id || "").match(/(?:^|\D)0*(\d+)\s*$/);
          const number = match ? match[1] : String(nft.object_id || "").slice(-6).toUpperCase();
          return {
            objectId: nft.object_id,
            name,
            imageUrl: nft.image_url || null,
            number,
            attemptStatus: attempt?.status || "available",
            completedCases: Number(attempt?.completed_cases || 0),
          };
        });
        const scanToken = randomBytes(24).toString("hex");
        await pool.query(
          `INSERT INTO voss_verified_scans (token_hash, payload, expires_at)
           VALUES ($1, $2::jsonb, NOW() + INTERVAL '5 minutes')`,
          [tokenHash(scanToken), JSON.stringify({ nfts: mapped })]
        );
        sendJson(res, 200, {
          nfts: mapped,
          scanPartial: false,
          count: mapped.length,
          scanToken,
        });
      } catch (err) {
        console.error("Gate scan error:", err);
        sendJson(res, 500, { detail: "Scan failed" });
      }
    },
  };
}

// Small helpers mirroring server.mjs's internal style.
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}
