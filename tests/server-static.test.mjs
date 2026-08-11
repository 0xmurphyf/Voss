import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const page = await readFile(new URL("../index.html", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../site.webmanifest", import.meta.url), "utf8"));
const favicon = await readFile(new URL("../favicon.ico", import.meta.url));

test("security-critical server controls remain present", () => {
  assert.match(server, /A completed NFT attempt is required to publish a share card/);
  assert.match(server, /fetchPublicImage/);
  assert.match(server, /isPrivateAddress/);
  assert.match(server, /voss_verified_scans/);
  assert.match(server, /BEGIN/);
  assert.match(server, /ROLLBACK/);
  assert.match(server, /d\.case_number=12/);
  assert.match(server, /case12:\{ total:case12Total, options:case12Options \}/);
});

test("retention and privacy disclosures stay aligned", () => {
  assert.doesNotMatch(server, /DELETE FROM voss_share_cards/);
  assert.match(server, /completed_at < NOW\(\) - INTERVAL '90 days'/);
  assert.doesNotMatch(page, /DATA &amp; PRIVACY/);
});

test("critical UI controls are present", () => {
  assert.match(page, /DISCONNECT WALLET/);
  assert.match(page, /SUBMIT DECISION/);
  assert.match(page, /SERVER RESULT DISTRIBUTION/);
  assert.match(page, /CASE 12 OPTION DISTRIBUTION/);
  assert.match(page, /GENERATE SHARE CARD/);
  assert.match(page, /rel="apple-touch-icon"/);
  assert.match(page, /rel="manifest" href="\/site\.webmanifest"/);
});

test("Slush app icon discovery metadata and fallbacks remain deployable", () => {
  assert.match(page, /rel="icon" type="image\/x-icon" sizes="16x16 32x32 48x48 64x64" href="\/favicon\.ico\?v=20260811"/);
  assert.match(page, /property="og:image" content="https:\/\/voss\.voxxinc\.xyz\/icon-192x192\.png\?v=20260811"/);
  assert.match(page, /property="og:image:width" content="192"/);
  assert.match(page, /property="og:image:height" content="192"/);
  assert.match(server, /"\.ico": "image\/x-icon"/);
  assert.match(server, /public, max-age=86400, stale-while-revalidate=604800/);
  assert.match(dockerfile, /favicon\.ico icon-192x192\.png icon-512x512\.png/);
  assert.equal(favicon.toString("hex", 0, 4), "00000100");
  assert.equal(favicon.readUInt16LE(4), 4, "favicon should contain four compatibility sizes");
  assert.ok(favicon.length < 64 * 1024, "favicon should stay small enough for app crawlers");
  assert.deepEqual(
    manifest.icons.map((icon) => icon.src),
    ["/icon-192x192.png?v=20260811", "/icon-512x512.png?v=20260811"]
  );
});

test("NFT numbers map to local PFP images with safe fallbacks", () => {
  assert.match(page, /function nftPfpUrl\(number\)/);
  assert.match(page, /\/assets\/PFP\/VOXX_\$\{String\(numeric\)\.padStart\(4, "0"\)\}\.webp/);
  assert.match(page, /data-fallback-srcs/);
  assert.match(page, /function nftCanvasImageSources\(nft\)/);
  assert.match(page, /loadCanvasImageFromSources\(nftImageUrls\)/);
  assert.match(page, /if \(__imgCache\.get\(src\) === p\) __imgCache\.delete\(src\)/);
});
