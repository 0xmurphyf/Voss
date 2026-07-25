import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number.parseInt(process.env.PORT || "4173", 10);
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
  try {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
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
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}).listen(port, "0.0.0.0", () => {
  console.log(`VOXX listening on http://127.0.0.1:${port}`);
});
