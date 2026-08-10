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
  assert.match(page, /state\.event === 11/);
  assert.doesNotMatch(page, /Humanity needs protection/);
  assert.doesNotMatch(page, /Humanity needs freedom/);
  assert.match(page, /GENERATE SHARE CARD/);
  assert.match(page, /rel="apple-touch-icon"/);
  assert.match(page, /rel="manifest" href="\/site\.webmanifest"/);
});
