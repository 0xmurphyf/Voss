import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "4173", 10);
const voxxstakeApi = (process.env.VOXXSTAKE_API_URL || "https://voxx.up.railway.app/api").replace(/\/$/, "");
const rateBuckets = new Map();
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
    CREATE TABLE IF NOT EXISTS voss_verified_scans (
      token_hash TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS voss_case_decisions (
      object_id TEXT NOT NULL REFERENCES voss_nft_attempts(object_id) ON DELETE CASCADE,
      case_number INTEGER NOT NULL CHECK (case_number BETWEEN 1 AND 12),
      choice TEXT NOT NULL,
      decision_tag TEXT NOT NULL,
      choice_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      state_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (object_id, case_number)
    );
    CREATE TABLE IF NOT EXISTS voss_share_cards (
      id TEXT PRIMARY KEY,
      object_id TEXT,
      image BYTEA NOT NULL,
      preview_image BYTEA,
      content_type TEXT NOT NULL DEFAULT 'image/png',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE voss_share_cards ADD COLUMN IF NOT EXISTS preview_image BYTEA;
    ALTER TABLE voss_share_cards ADD COLUMN IF NOT EXISTS object_id TEXT;
    CREATE INDEX IF NOT EXISTS voss_share_cards_object_created_idx ON voss_share_cards(object_id, created_at)
  `);
  attemptsReady.then(() => cleanupExpiredData()).catch(error => console.error("Initial data cleanup failed:", error));
  const cleanupTimer = setInterval(() => {
    cleanupExpiredData().catch(error => console.error("Scheduled data cleanup failed:", error));
  }, 6 * 60 * 60_000);
  cleanupTimer.unref();
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

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function allowRequest(req, res, scope, limit, windowMs) {
  const now = Date.now();
  if (rateBuckets.size > 5000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }
  const key = `${scope}:${requestIp(req)}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count:1, resetAt:now + windowMs });
    return true;
  }
  if (bucket.count >= limit) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    sendJson(res, 429, { detail:"Too many requests. Try again later." });
    return false;
  }
  bucket.count += 1;
  return true;
}

async function cleanupExpiredData() {
  if (!pool) return;
  await pool.query("DELETE FROM voss_verified_scans WHERE expires_at < NOW() - INTERVAL '1 day' OR used_at < NOW() - INTERVAL '1 day'");
  await pool.query("UPDATE voss_nft_attempts SET wallet_address=NULL WHERE completed_at < NOW() - INTERVAL '90 days' AND wallet_address IS NOT NULL");
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number);
    const [a,b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(normalized) === 6) {
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized);
  }
  return true;
}

async function assertPublicImageUrl(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("NFT image source is not allowed");
  if (url.username || url.password) throw new Error("NFT image source is not allowed");
  const addresses = isIP(url.hostname)
    ? [{ address:url.hostname }]
    : await lookup(url.hostname, { all:true, verbatim:true });
  if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) {
    throw new Error("NFT image source is not allowed");
  }
  return url;
}

async function fetchPublicImage(value, maxBytes) {
  let current = await assertPublicImageUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(current, {
      redirect:"manual",
      signal:AbortSignal.timeout(10_000),
      headers:{ Accept:"image/*" }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("NFT image redirect is not allowed");
      current = await assertPublicImageUrl(new URL(location, current).href);
      continue;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
      throw new Error("NFT image source did not return an image");
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) throw new Error("NFT image is too large");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("NFT image source is unavailable");
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value:chunk } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("NFT image is too large");
      }
      chunks.push(Buffer.from(chunk));
    }
    return { image:Buffer.concat(chunks), contentType };
  }
  throw new Error("NFT image is unavailable");
}

async function proxyVoxxstake(path, body, authorization) {
  const response = await fetch(`${voxxstakeApi}${path}`, {
    method: "POST",
    signal:AbortSignal.timeout(15_000),
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

async function lockVerifiedScan(client, scanToken, objectId) {
  const result = await client.query(
    `SELECT payload FROM voss_verified_scans
     WHERE token_hash=$1 AND expires_at>NOW() AND used_at IS NULL
     FOR UPDATE`,
    [tokenHash(scanToken || "")]
  );
  const nfts = Array.isArray(result.rows[0]?.payload?.nfts) ? result.rows[0].payload.nfts : [];
  const nft = nfts.find(item => item?.objectId === objectId);
  if (!nft) return null;
  return nft;
}

createServer(async (req, res) => {
  let requestedPath = "";
  try {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    requestedPath = raw;

    if (raw === "/api/gate/nonce" && req.method === "POST") {
      if (!allowRequest(req, res, "gate-nonce", 20, 60_000)) return;
      const upstream = await proxyVoxxstake("/auth/nonce", await readJsonBody(req));
      sendJson(res, upstream.status, upstream.data);
      return;
    }

    if (raw === "/api/gate/verify" && req.method === "POST") {
      if (!allowRequest(req, res, "gate-verify", 20, 60_000)) return;
      const upstream = await proxyVoxxstake("/auth/verify", await readJsonBody(req));
      sendJson(res, upstream.status, upstream.data);
      return;
    }

    if (raw === "/api/gate/scan" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      if (!allowRequest(req, res, "gate-scan", 12, 60_000)) return;
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
      const scanToken = randomBytes(24).toString("hex");
      await pool.query(
        `INSERT INTO voss_verified_scans (token_hash, payload, expires_at)
         VALUES ($1, $2::jsonb, NOW() + INTERVAL '5 minutes')`,
        [tokenHash(scanToken), JSON.stringify({ nfts:ownership.nfts })]
      );
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
      await attemptsReady;
      const attemptToken = randomBytes(32).toString("hex");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const verifiedNft = await lockVerifiedScan(client, body.scanToken, body.objectId);
        if (!verifiedNft) {
          await client.query("ROLLBACK");
          sendJson(res, 403, { detail:"A fresh ownership scan is required" });
          return;
        }
        await client.query(
          `INSERT INTO voss_nft_attempts
            (object_id, nft_number, nft_name, image_url, wallet_address, attempt_token_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [body.objectId, String(body.number || "UNKNOWN"), String(body.name || "VOXX NFT"), verifiedNft?.imageUrl || null, body.address || null, tokenHash(attemptToken)]
        );
        await client.query("UPDATE voss_verified_scans SET used_at=NOW() WHERE token_hash=$1", [tokenHash(body.scanToken || "")]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
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
      } finally {
        client.release();
      }
      sendJson(res, 201, { attemptToken, status:"started", completedCases:0 });
      return;
    }

    if (raw === "/api/attempt/resume" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      const body = await readJsonBody(req);
      await attemptsReady;
      const attemptToken = randomBytes(32).toString("hex");
      const client = await pool.connect();
      let resumed;
      try {
        await client.query("BEGIN");
        const verifiedNft = await lockVerifiedScan(client, body.scanToken, body.objectId);
        if (!verifiedNft) {
          await client.query("ROLLBACK");
          sendJson(res, 403, { detail:"A fresh ownership scan is required" });
          return;
        }
        resumed = await client.query(
          `UPDATE voss_nft_attempts
           SET attempt_token_hash=$1, wallet_address=COALESCE($2,wallet_address),
               image_url=COALESCE($3,image_url), updated_at=NOW()
           WHERE object_id=$4 AND status='started'
           RETURNING completed_cases, progress`,
          [tokenHash(attemptToken), body.address || null, verifiedNft?.imageUrl || null, body.objectId]
        );
        if (!resumed.rowCount) {
          await client.query("ROLLBACK");
          sendJson(res, 409, { detail:"No unfinished attempt is available" });
          return;
        }
        await client.query("UPDATE voss_verified_scans SET used_at=NOW() WHERE token_hash=$1", [tokenHash(body.scanToken || "")]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
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
      if (!allowRequest(req, res, "nft-image", 60, 60_000)) return;
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
      try {
        const { image, contentType } = await fetchPublicImage(imageUrl, 12 * 1024 * 1024);
        res.writeHead(200, {
          "Content-Type":contentType,
          "Content-Length":image.length,
          "Cache-Control":"public, max-age=3600"
        });
        res.end(image);
      } catch (error) {
        sendJson(res, 502, { detail:error.message || "NFT image is unavailable" });
      }
      return;
    }

    if (raw === "/api/share-card" && req.method === "POST") {
      if (!requireAttemptsDatabase(res)) return;
      if (!allowRequest(req, res, "share-card", 6, 60 * 60_000)) return;
      const authorization = String(req.headers.authorization || "");
      const objectId = String(req.headers["x-nft-object-id"] || "");
      const attemptToken = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
      await attemptsReady;
      const authorized = await pool.query(
        `SELECT 1 FROM voss_nft_attempts
         WHERE object_id=$1 AND attempt_token_hash=$2 AND status='completed'`,
        [objectId, tokenHash(attemptToken)]
      );
      if (!authorized.rowCount) {
        sendJson(res, 403, { detail:"A completed NFT attempt is required to publish a share card" });
        return;
      }
      const recentCards = await pool.query(
        "SELECT COUNT(*)::int AS count FROM voss_share_cards WHERE object_id=$1",
        [objectId]
      );
      if (Number(recentCards.rows[0]?.count || 0) >= 5) {
        sendJson(res, 429, { detail:"This NFT has reached its share-card limit" });
        return;
      }
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const match = String(body.dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      const previewMatch = String(body.previewDataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
      if (!match || !previewMatch) {
        sendJson(res, 400, { detail:"PNG share card images are required" });
        return;
      }
      const image = Buffer.from(match[1], "base64");
      const previewImage = Buffer.from(previewMatch[1], "base64");
      if (!image.length || !previewImage.length || image.length > 6 * 1024 * 1024 || previewImage.length > 4 * 1024 * 1024) {
        sendJson(res, 413, { detail:"Share card image is too large" });
        return;
      }
      await attemptsReady;
      const id = randomBytes(12).toString("hex");
      await pool.query(
        "INSERT INTO voss_share_cards (id, object_id, image, preview_image, content_type) VALUES ($1, $2, $3, $4, 'image/png')",
        [id, objectId, image, previewImage]
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
<title>TEST RESULT</title>
<meta name="description" content="VOSS Protocol Final Evaluation">
<meta property="og:type" content="website">
<meta property="og:title" content="TEST RESULT">
<meta property="og:description" content="VOSS Protocol Final Evaluation">
<meta property="og:image" content="${previewUrl}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="TEST RESULT">
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
      const progress = body.progress && typeof body.progress === "object" ? body.progress : {};
      const history = Array.isArray(progress.history) ? progress.history : [];
      const decision = completedCases > 0 ? history[completedCases - 1] : null;
      const client = await pool.connect();
      let updated;
      try {
        await client.query("BEGIN");
        updated = await client.query(
          `UPDATE voss_nft_attempts
           SET completed_cases=GREATEST(completed_cases,$1), progress=$2::jsonb, updated_at=NOW()
           WHERE object_id=$3 AND attempt_token_hash=$4 AND status='started'
           RETURNING completed_cases`,
          [completedCases, JSON.stringify(progress), body.objectId, tokenHash(body.attemptToken || "")]
        );
        if (!updated.rowCount) {
          await client.query("ROLLBACK");
          sendJson(res, 403, { detail:"Active NFT attempt not found" });
          return;
        }
        if (decision) {
          await client.query(
            `INSERT INTO voss_case_decisions
               (object_id, case_number, choice, decision_tag, choice_result, state_result)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
             ON CONFLICT (object_id, case_number) DO UPDATE SET
               choice=EXCLUDED.choice,
               decision_tag=EXCLUDED.decision_tag,
               choice_result=EXCLUDED.choice_result,
               state_result=EXCLUDED.state_result,
               recorded_at=NOW()`,
            [
              body.objectId,
              completedCases,
              String(decision.choice || "UNKNOWN").slice(0, 1000),
              String(decision.tag || "NEUTRAL").slice(0, 80),
              JSON.stringify(decision.changes || {}),
              JSON.stringify(progress.state || {})
            ]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      sendJson(res, 200, { completedCases:Number(updated.rows[0].completed_cases) });
      return;
    }

    if (raw === "/api/results/stats" && req.method === "GET") {
      if (!requireAttemptsDatabase(res)) return;
      await attemptsReady;
      const result = await pool.query(
        `SELECT COALESCE(final_outcome->>'type','UNKNOWN') AS type, COUNT(*)::int AS count
         FROM voss_nft_attempts
         WHERE status='completed'
         GROUP BY COALESCE(final_outcome->>'type','UNKNOWN')`
      );
      const counts = Object.fromEntries(result.rows.map((row) => [row.type, Number(row.count)]));
      const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
      const case12Result = await pool.query(
        `SELECT split_part(d.choice, '<br>', 1) AS choice, COUNT(*)::int AS count
         FROM voss_case_decisions d
         INNER JOIN voss_nft_attempts a ON a.object_id=d.object_id
         WHERE d.case_number=12 AND a.status='completed'
         GROUP BY split_part(d.choice, '<br>', 1)
         ORDER BY count DESC, choice ASC`
      );
      const case12Options = case12Result.rows.map((row) => ({
        choice:String(row.choice || "UNKNOWN"),
        count:Number(row.count)
      }));
      const case12Total = case12Options.reduce((sum, option) => sum + option.count, 0);
      sendJson(res, 200, {
        total,
        counts,
        case12:{ total:case12Total, options:case12Options }
      });
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
    if (requestedPath.startsWith("/api/")) {
      console.error("VOSS API request failed:", error);
      sendJson(res, 502, { detail: "VOSS service is temporarily unavailable" });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`VOXX listening on http://127.0.0.1:${port}`);
});
