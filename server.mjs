import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "4173", 10);
const voxxstakeApi = (process.env.VOXXSTAKE_API_URL || "https://voxx.up.railway.app/api").replace(/\/$/, "");
const verifiedScans = new Map();
let pool = null;
let attemptsReady = Promise.resolve();

if (process.env.DATABASE_URL) {
  const { Pool } = await import("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized:false }
  });
  attemptsReady = pool.query(`
    CREATE TABLE IF NOT EXISTS voss_nft_attempts (
      object_id TEXT PRIMARY KEY,
      nft_number TEXT NOT NULL,
      nft_name TEXT NOT NULL,
      wallet_address TEXT,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed')),
      completed_cases INTEGER NOT NULL DEFAULT 0 CHECK (completed_cases BETWEEN 0 AND 12),
      attempt_token_hash TEXT NOT NULL,
      progress JSONB,
      final_outcome JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )
  `);
}
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4"
};

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.length,
    "Cache-Control": "no-store"
  });
  res.end(encoded);
}

async function proxyVoxxstake(path, body, authorization) {
  const response = await fetch(`${voxxstakeApi}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({ detail: "Invalid response from ownership service" }));
  return { status: response.status, data };
}

function nftNumber(position) {
  const name = String(position.name || "");
  const explicit = name.match(/#\s*0*(\d+)/);
  if (explicit) return explicit[1];
  const trailing = name.match(/(?:^|\D)0*(\d+)\s*$/);
  if (trailing) return trailing[1];
  return String(position.object_id || "").slice(-6).toUpperCase();
}

function tokenHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function requireAttemptsDatabase(res) {
  if (pool) return true;
  sendJson(res, 503, { detail:"NFT attempt database is not configured" });
  return false;
}

async function ownedNftsFromVoxxstake(authorization) {
  const upstream = await proxyVoxxstake("/staking/sync", {}, authorization);
  if (upstream.status >= 400) return { error:upstream };
  const scanPartial = upstream.data.scan_partial === true;
  const positions = Array.isArray(upstream.data.positions) ? upstream.data.positions : [];
  const nfts = scanPartial ? [] : positions
    .filter((position) => position && position.is_owned === true)
    .map((position) => ({
      objectId:position.object_id,
      name:position.name || `VOXX #${String(position.object_id || "").slice(-6)}`,
      imageUrl:position.image_url || null,
      number:nftNumber(position)
    }));
  return { nfts, scanPartial };
}

function cleanupVerifiedScans() {
  const now = Date.now();
  for (const [key, value] of verifiedScans) {
    if (value.expiresAt <= now) verifiedScans.delete(key);
  }
}

createServer(async (req, res) => {
  let requestedPath = "";
  try {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    requestedPath = raw;

    if (raw === "/api/gate/nonce" && req.method === "POST") {
      const upstream = await proxyVoxxstake("/auth/nonce", await readJsonBody(req));
      sendJson(res, upstream.status, upstream.data);
      return;
    }

    if (raw === "/api/gate/verify" && req.method === "POST") {
      const upstream = await proxyVoxxstake("/auth/verify", await readJsonBody(req));
      sendJson(res, upstream.status, upstream.data);
      return;
    }

    if (raw === "/api/gate/scan" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const authorization = req.headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) {
        sendJson(res, 401, { detail: "Wallet authentication required" });
        return;
      }
      const ownership = await ownedNftsFromVoxxstake(authorization);
      if (ownership.error) {
        sendJson(res, ownership.error.status, ownership.error.data);
        return;
      }
      await attemptsReady;
      const ids = ownership.nfts.map((nft) => nft.objectId);
      const attempts = ids.length
        ? await pool.query(
            "SELECT object_id, status, completed_cases FROM voss_nft_attempts WHERE object_id = ANY($1::text[])",
            [ids]
          )
        : { rows:[] };
      const attemptById = new Map(attempts.rows.map((row) => [row.object_id, row]));
      const nfts = ownership.nfts.map((nft) => {
        const attempt = attemptById.get(nft.objectId);
        return {
          ...nft,
          attemptStatus:attempt?.status || "available",
          completedCases:Number(attempt?.completed_cases || 0)
        };
      });
      cleanupVerifiedScans();
      const scanToken = randomBytes(24).toString("hex");
      verifiedScans.set(scanToken, {
        objectIds:new Set(ids),
        expiresAt:Date.now() + 5 * 60_000
      });
      sendJson(res, 200, {
        nfts,
        scanPartial:ownership.scanPartial,
        count:nfts.length,
        scanToken
      });
      return;
    }

    if (raw === "/api/attempt/start" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req);
      const verified = verifiedScans.get(String(body.scanToken || ""));
      if (!verified || verified.expiresAt <= Date.now() || !verified.objectIds.has(body.objectId)) {
        sendJson(res, 403, { detail:"A fresh ownership scan is required" });
        return;
      }
      await attemptsReady;
      const attemptToken = randomBytes(32).toString("hex");
      try {
        await pool.query(
          `INSERT INTO voss_nft_attempts
            (object_id, nft_number, nft_name, wallet_address, attempt_token_hash)
           VALUES ($1, $2, $3, $4, $5)`,
          [body.objectId, String(body.number || "UNKNOWN"), String(body.name || "VOXX NFT"), body.address || null, tokenHash(attemptToken)]
        );
      } catch (error) {
        if (error?.code === "23505") {
          const existing = await pool.query(
            "SELECT status, completed_cases FROM voss_nft_attempts WHERE object_id=$1",
            [body.objectId]
          );
          sendJson(res, 409, {
            detail:"This NFT has already used its single attempt",
            attemptStatus:existing.rows[0]?.status || "started",
            completedCases:Number(existing.rows[0]?.completed_cases || 0)
          });
          return;
        }
        throw error;
      }
      verifiedScans.delete(String(body.scanToken));
      sendJson(res, 201, { attemptToken, status:"started", completedCases:0 });
      return;
    }

    if (raw === "/api/attempt/progress" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req);
      const completedCases = Number(body.completedCases);
      if (!Number.isInteger(completedCases) || completedCases < 0 || completedCases > 12) {
        sendJson(res, 400, { detail:"Invalid completed case count" });
        return;
      }
      await attemptsReady;
      const updated = await pool.query(
        `UPDATE voss_nft_attempts
         SET completed_cases=GREATEST(completed_cases,$1), progress=$2::jsonb, updated_at=NOW()
         WHERE object_id=$3 AND attempt_token_hash=$4 AND status='started'
         RETURNING completed_cases`,
        [completedCases, JSON.stringify(body.progress || {}), body.objectId, tokenHash(body.attemptToken || "")]
      );
      if (!updated.rowCount) {
        sendJson(res, 403, { detail:"Active NFT attempt not found" });
        return;
      }
      sendJson(res, 200, { completedCases:Number(updated.rows[0].completed_cases) });
      return;
    }

    if (raw === "/api/attempt/complete" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req);
      await attemptsReady;
      const updated = await pool.query(
        `UPDATE voss_nft_attempts
         SET status='completed', completed_cases=12, final_outcome=$1::jsonb,
             completed_at=NOW(), updated_at=NOW()
         WHERE object_id=$2 AND attempt_token_hash=$3 AND status='started' AND completed_cases>=12
         RETURNING object_id, completed_at`,
        [JSON.stringify(body.finalOutcome || {}), body.objectId, tokenHash(body.attemptToken || "")]
      );
      if (!updated.rowCount) {
        sendJson(res, 409, { detail:"All 12 cases must be recorded before Final" });
        return;
      }
      sendJson(res, 200, { status:"completed", completedAt:updated.rows[0].completed_at });
      return;
    }

    const relative = raw === "/" ? "index.html" : raw.replace(/^\/+/, "");
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error("invalid path");

    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");

    const contentType = types[extname(path)] || "application/octet-stream";
    const range = req.headers.range;

    if (range && contentType === "video/mp4") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) throw new Error("invalid range");

      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2]
        ? Math.min(Number.parseInt(match[2], 10), info.size - 1)
        : info.size - 1;
      if (start > end || start >= info.size) throw new Error("invalid range");

      const body = (await readFile(path)).subarray(start, end + 1);
      res.writeHead(206, {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": body.length,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400"
      });
      res.end(body);
      return;
    }

    const body = await readFile(path);
    res.writeHead(200, {
      "Accept-Ranges": contentType === "video/mp4" ? "bytes" : "none",
      "Content-Length": body.length,
      "Content-Type": contentType,
      "Cache-Control": contentType === "video/mp4"
        ? "public, max-age=86400"
        : "no-store"
    });
    res.end(body);
  } catch (error) {
    if (requestedPath.startsWith("/api/gate/") || requestedPath.startsWith("/api/attempt/")) {
      console.error("NFT gate request failed:", error);
      sendJson(res, 502, { detail: "NFT attempt service is temporarily unavailable" });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`VOXX listening on http://127.0.0.1:${port}`);
});
