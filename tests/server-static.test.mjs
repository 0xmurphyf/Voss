import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const page = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("security-critical server controls remain present", () => {
  assert.match(server, /A completed NFT attempt is required to publish a share card/);
  assert.match(server, /fetchPublicImage/);
  assert.match(server, /isPrivateAddress/);
  assert.match(server, /voss_verified_scans/);
  assert.match(server, /BEGIN/);
  assert.match(server, /ROLLBACK/);
});

test("retention and privacy disclosures stay aligned", () => {
  assert.match(server, /voss_share_cards WHERE created_at < NOW\(\) - INTERVAL '30 days'/);
  assert.match(server, /completed_at < NOW\(\) - INTERVAL '90 days'/);
  assert.match(page, /Share-card images expire after 30 days/);
  assert.match(page, /Wallet addresses are removed from completed records after 90 days/);
});

test("critical UI controls are present", () => {
  assert.match(page, /DISCONNECT WALLET/);
  assert.match(page, /SUBMIT DECISION/);
  assert.match(page, /SERVER RESULT DISTRIBUTION/);
  assert.match(page, /GENERATE SHARE CARD/);
});
