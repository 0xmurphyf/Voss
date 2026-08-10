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
      image_url TEXT,
      wallet_address TEXT,
      status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed')),
      completed_cases INTEGER NOT NULL DEFAULT 0 CHECK (completed_cases BETWEEN 0 AND 12),
      attempt_token_hash TEXT NOT NULL,
      progress JSONB,
      final_outcome JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    ALTER TABLE voss_nft_attempts ADD COLUMN IF NOT EXISTS image_url TEXT;
    CREATE TABLE IF NOT EXISTS voss_share_cards (
      id TEXT PRIMARY KEY,
      image BYTEA NOT NULL,
      preview_image BYTEA,
      content_type TEXT NOT NULL DEFAULT 'image/png',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE voss_share_cards ADD COLUMN IF NOT EXISTS preview_image BYTEA
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

async function readJsonBody(req, maxSize = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) throw new Error("request body too large");
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
        nftsById:new Map(ownership.nfts.map((nft) => [nft.objectId, nft])),
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
      const verifiedNft = verified.nftsById.get(body.objectId);
      try {
        await pool.query(
          `INSERT INTO voss_nft_attempts
            (object_id, nft_number, nft_name, image_url, wallet_address, attempt_token_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [body.objectId, String(body.number || "UNKNOWN"), String(body.name || "VOXX NFT"), verifiedNft?.imageUrl || null, body.address || null, tokenHash(attemptToken)]
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

    if (raw === "/api/attempt/resume" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req);
      const verified = verifiedScans.get(String(body.scanToken || ""));
      if (!verified || verified.expiresAt <= Date.now() || !verified.objectIds.has(body.objectId)) {
        sendJson(res, 403, { detail:"A fresh ownership scan is required" });
        return;
      }
      await attemptsReady;
      const attemptToken = randomBytes(32).toString("hex");
      const verifiedNft = verified.nftsById.get(body.objectId);
      const resumed = await pool.query(
        `UPDATE voss_nft_attempts
         SET attempt_token_hash=$1, wallet_address=COALESCE($2,wallet_address),
             image_url=COALESCE($3,image_url), updated_at=NOW()
         WHERE object_id=$4 AND status='started'
         RETURNING completed_cases, progress`,
        [tokenHash(attemptToken), body.address || null, verifiedNft?.imageUrl || null, body.objectId]
      );
      if (!resumed.rowCount) {
        sendJson(res, 409, { detail:"No unfinished attempt is available" });
        return;
      }
      verifiedScans.delete(String(body.scanToken));
      sendJson(res, 200, {
        attemptToken,
        status:"started",
        completedCases:Number(resumed.rows[0].completed_cases || 0),
        progress:resumed.rows[0].progress || null
      });
      return;
    }

    const nftImageMatch = raw.match(/^\/api\/nft-image\/(0x[0-9a-fA-F]{64})$/);
    if (nftImageMatch && req.method === "GET") {
      if (!requireAttemptsDatabase(res)) return;
      await attemptsReady;
      const result = await pool.query(
        "SELECT image_url FROM voss_nft_attempts WHERE object_id=$1",
        [nftImageMatch[1]]
      );
      const imageUrl = result.rows[0]?.image_url;
      if (!imageUrl) {
        sendJson(res, 404, { detail:"NFT image is unavailable" });
        return;
      }
      let parsed;
      try {
        parsed = new URL(imageUrl);
      } catch {
        sendJson(res, 404, { detail:"NFT image URL is invalid" });
        return;
      }
      if (!/^https?:$/.test(parsed.protocol) || parsed.hostname === "localhost" || parsed.hostname.endsWith(".local")) {
        sendJson(res, 403, { detail:"NFT image source is not allowed" });
        return;
      }
      const imageResponse = await fetch(parsed, { headers:{ Accept:"image/*" } });
      const contentType = imageResponse.headers.get("content-type") || "";
      if (!imageResponse.ok || !contentType.toLowerCase().startsWith("image/")) {
        sendJson(res, 502, { detail:"NFT image source did not return an image" });
        return;
      }
      const image = Buffer.from(await imageResponse.arrayBuffer());
      if (image.length > 12 * 1024 * 1024) {
        sendJson(res, 413, { detail:"NFT image is too large" });
        return;
      }
      res.writeHead(200, {
        "Content-Type":contentType,
        "Content-Length":image.length,
        "Cache-Control":"public, max-age=3600"
      });
      res.end(image);
      return;
    }

    if (raw === "/api/share-card" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req, 6 * 1024 * 1024);
      const match = String(body.dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      const previewMatch = String(body.previewDataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!match || !previewMatch) {
        sendJson(res, 400, { detail:"PNG share card images are required" });
        return;
      }
      const image = Buffer.from(match[1], "base64");
      const previewImage = Buffer.from(previewMatch[1], "base64");
      if (!image.length || !previewImage.length || image.length > 2 * 1024 * 1024 || previewImage.length > 3 * 1024 * 1024) {
        sendJson(res, 413, { detail:"Share card image is too large" });
        return;
      }
      await attemptsReady;
      const id = randomBytes(12).toString("hex");
      await pool.query(
        "INSERT INTO voss_share_cards (id, image, preview_image, content_type) VALUES ($1, $2, $3, 'image/png')",
        [id, image, previewImage]
      );
      sendJson(res, 201, { url:`/share/${id}`, imageUrl:`/share/${id}.png`, previewUrl:`/share/${id}-preview.png` });
      return;
    }

    const sharePageMatch = raw.match(/^\/share\/([0-9a-f]{24})$/);
    if (sharePageMatch && req.method === "GET") {
      if (!requireAttemptsDatabase(res)) return;
      await attemptsReady;
      const exists = await pool.query("SELECT 1 FROM voss_share_cards WHERE id=$1", [sharePageMatch[1]]);
      if (!exists.rowCount) {
        sendJson(res, 404, { detail:"Share card not found" });
        return;
      }
      const forwardedProto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
      const protocol = forwardedProto === "http" ? "http" : "https";
      const forwardedHost = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
      const host = /^[A-Za-z0-9.-]+(?::\d+)?$/.test(forwardedHost) ? forwardedHost : "localhost";
      const imageUrl = `${protocol}://${host}/share/${sharePageMatch[1]}.png`;
      const previewUrl = `${protocol}://${host}/share/${sharePageMatch[1]}-preview.png`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>I passed the test</title>
<meta name="description" content="VOSS Protocol Final Evaluation">
<meta property="og:type" content="website">
<meta property="og:title" content="I passed the test">
<meta property="og:description" content="VOSS Protocol Final Evaluation">
<meta property="og:image" content="${previewUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="I passed the test">
<meta name="twitter:description" content="VOSS Protocol Final Evaluation">
<meta name="twitter:image" content="${previewUrl}">
<style>
html,body{margin:0;min-height:100%;background:#020407;color:#f2f5f7;font-family:Inter,"Segoe UI",Arial,sans-serif}
body{display:grid;place-items:center;padding:28px 16px;box-sizing:border-box}
main{width:100%;display:flex;flex-direction:column;align-items:center;gap:20px}
img{display:block;width:min(720px,100%);height:auto;border:1px solid #263744;box-shadow:0 18px 70px rgba(0,0,0,.55)}
a{display:inline-block;padding:12px 24px;border:1px solid #63d8ff;color:#63d8ff;background:#070b10;text-decoration:none;letter-spacing:2px;font-size:13px}
a:hover{background:#10202a;color:#fff}
</style>
</head><body><main><img src="${imageUrl}" alt="VOSS Protocol Final Evaluation"><a href="https://voss.up.railway.app">JOIN THE TEST</a></main></body></html>`;
      const encoded = Buffer.from(html);
      res.writeHead(200, {
        "Content-Type":"text/html; charset=utf-8",
        "Content-Length":encoded.length,
        "Cache-Control":"public, max-age=3600"
      });
      res.end(encoded);
      return;
    }

    const sharePreviewMatch = raw.match(/^\/share\/([0-9a-f]{24})-preview\.png$/);
    if (sharePreviewMatch && req.method === "GET") {
      if (!requireAttemptsDatabase(res)) return;
      await attemptsReady;
      const result = await pool.query(
        "SELECT preview_image, image, content_type FROM voss_share_cards WHERE id=$1",
        [sharePreviewMatch[1]]
      );
      if (!result.rowCount) {
        sendJson(res, 404, { detail:"Share preview not found" });
        return;
      }
      const image = result.rows[0].preview_image || result.rows[0].image;
      res.writeHead(200, {
        "Content-Type":result.rows[0].content_type,
        "Content-Length":image.length,
        "Cache-Control":"public, max-age=31536000, immutable"
      });
      res.end(image);
      return;
    }

    const shareCardMatch = raw.match(/^\/share\/([0-9a-f]{24})\.png$/);
    if (shareCardMatch && req.method === "GET") {
      if (!requireAttemptsDatabase(res)) return;
      await attemptsReady;
      const result = await pool.query(
        "SELECT image, content_type FROM voss_share_cards WHERE id=$1",
        [shareCardMatch[1]]
      );
      if (!result.rowCount) {
        sendJson(res, 404, { detail:"Share card not found" });
        return;
      }
      const image = result.rows[0].image;
      res.writeHead(200, {
        "Content-Type":result.rows[0].content_type,
        "Content-Length":image.length,
        "Cache-Control":"public, max-age=31536000, immutable"
      });
      res.end(image);
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
