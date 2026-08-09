import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "4173", 10);
const voxxstakeApi = (process.env.VOXXSTAKE_API_URL || "https://voxx.up.railway.app/api").replace(/\/$/, "");
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
      const authorization = req.headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) {
        sendJson(res, 401, { detail: "Wallet authentication required" });
        return;
      }
      const upstream = await proxyVoxxstake("/staking/sync", {}, authorization);
      if (upstream.status >= 400) {
        sendJson(res, upstream.status, upstream.data);
        return;
      }
      const positions = Array.isArray(upstream.data.positions) ? upstream.data.positions : [];
      const scanPartial = upstream.data.scan_partial === true;
      const nfts = scanPartial ? [] : positions
        .filter((position) => position && position.is_owned === true)
        .map((position) => ({
          objectId: position.object_id,
          name: position.name || `VOXX #${String(position.object_id || "").slice(-6)}`,
          imageUrl: position.image_url || null,
          number: nftNumber(position)
        }));
      sendJson(res, 200, {
        nfts,
        scanPartial,
        count: nfts.length
      });
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
    if (requestedPath.startsWith("/api/gate/")) {
      console.error("NFT gate request failed:", error);
      sendJson(res, 502, { detail: "Ownership service is temporarily unavailable" });
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`VOXX listening on http://127.0.0.1:${port}`);
});
