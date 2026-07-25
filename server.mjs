import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "4173", 10);
let developmentCounter = 1499;
let pool = null;
let counterReady = Promise.resolve();

if (process.env.DATABASE_URL) {
  const { Pool } = await import("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false }
  });
  counterReady = pool.query(`
    CREATE TABLE IF NOT EXISTS voss_counters (
      name TEXT PRIMARY KEY,
      value BIGINT NOT NULL
    );
    INSERT INTO voss_counters (name, value)
    VALUES ('candidate', 1499)
    ON CONFLICT (name) DO NOTHING;
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

createServer(async (req, res) => {
  let requestedPath = "";
  try {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    requestedPath = raw;

    if (raw === "/api/candidate/allocate" && req.method === "POST") {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");

      if (pool) {
        await counterReady;
        const result = await pool.query(`
          UPDATE voss_counters
          SET value = value + 1
          WHERE name = 'candidate'
          RETURNING value
        `);
        res.writeHead(200);
        res.end(JSON.stringify({ candidateNumber: Number(result.rows[0].value) }));
        return;
      }

      if (!process.env.RAILWAY_ENVIRONMENT) {
        developmentCounter += 1;
        res.writeHead(200);
        res.end(JSON.stringify({
          candidateNumber: developmentCounter,
          developmentFallback: true
        }));
        return;
      }

      res.writeHead(503);
      res.end(JSON.stringify({
        error: "Global candidate counter requires DATABASE_URL"
      }));
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
    if (requestedPath === "/api/candidate/allocate") {
      console.error("Candidate allocation failed:", error);
      res.writeHead(500, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.end(JSON.stringify({ error: "Global counter is temporarily unavailable" }));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`VOXX listening on http://127.0.0.1:${port}`);
});
