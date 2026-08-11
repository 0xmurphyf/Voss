import { test, expect } from "@playwright/test";

const address = `0x${"1".repeat(64)}`;
const objectId = `0x${"2".repeat(64)}`;

async function mockWallet(page) {
  await page.addInitScript(({ address }) => {
    const account = { address, chains:["sui:mainnet"], features:[] };
    const wallet = {
      name:"TEST SUI WALLET",
      version:"1.0.0",
      chains:["sui:mainnet"],
      accounts:[account],
      features:{
        "standard:connect":{ version:"1.0.0", connect:async () => ({ accounts:[account] }) },
        "standard:disconnect":{ version:"1.0.0", disconnect:async () => {} },
        "sui:signPersonalMessage":{ version:"1.0.0", signPersonalMessage:async () => ({ signature:"test", bytes:"test" }) }
      }
    };
    window.addEventListener("wallet-standard:app-ready", event => event.detail.register(wallet));
  }, { address });
}

async function mockApis(page) {
  await page.route("**/api/gate/nonce", route => route.fulfill({ json:{ nonce:"test-nonce" } }));
  await page.route("**/api/gate/verify", route => route.fulfill({ json:{ token:"gate-token" } }));
  await page.route("**/api/gate/scan", route => route.fulfill({ json:{
    nfts:[{ objectId, name:"VOXX #7", imageUrl:null, number:"7", attemptStatus:"available", completedCases:0 }],
    scanPartial:false, count:1, scanToken:"scan-token"
  } }));
  await page.route("**/api/attempt/start", route => route.fulfill({ status:201, json:{ attemptToken:"attempt-token", status:"started", completedCases:0 } }));
  await page.route("**/api/attempt/progress", route => route.fulfill({ json:{ completedCases:1 } }));
  await page.route("**/api/attempt/complete", route => route.fulfill({ json:{ status:"completed" } }));
  await page.route("**/api/results/stats", route => route.fulfill({ json:{ total:1, counts:{ A:1 } } }));
  await page.route("**/api/share-card", route => route.fulfill({ status:201, json:{ url:"/share/test" } }));
}

test("Slush icon endpoints expose crawler-compatible headers", async ({ request }) => {
  const assets = [
    ["/favicon.ico?v=20260811", "image/x-icon"],
    ["/icon-192x192.png?v=20260811", "image/png"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/assets/PFP/VOXX_0007.webp", "image/webp"]
  ];

  for (const [url, contentType] of assets) {
    const response = await request.get(url);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain(contentType);
    expect(response.headers()["cache-control"]).toContain("public, max-age=86400");
    expect(response.headers()["cache-control"]).not.toContain("no-store");
  }
});

test("NFT numbers prefer local PFPs and fall back to the upstream image", async ({ page }) => {
  await page.route("**/assets/PFP/VOXX_0152.webp", route => route.fulfill({ status:404, body:"Not found" }));
  await page.goto("/");
  const paths = await page.evaluate(() => ({
    seven:nftPfpUrl("7"),
    padded:nftPfpUrl("0007"),
    invalid:nftPfpUrl("TEST"),
    outside:nftPfpUrl("3001"),
    displaySources:nftDisplayImageSources({
      number:"152",
      objectId:`0x${"2".repeat(64)}`,
      imageUrl:"https://example.com/upstream.webp"
    }),
    canvasSources:nftCanvasImageSources({
      number:"152",
      objectId:`0x${"2".repeat(64)}`,
      imageUrl:"https://example.com/upstream.webp"
    }),
    escapedMarkup:nftImageMarkup({
      number:"7",
      name:'"><script>alert(1)</script>',
      imageUrl:"javascript:alert(1)"
    })
  }));
  expect(paths.seven).toBe("/assets/PFP/VOXX_0007.webp");
  expect(paths.padded).toBe("/assets/PFP/VOXX_0007.webp");
  expect(paths.invalid).toBe("");
  expect(paths.outside).toBe("");
  expect(paths.displaySources).toEqual([
    "/assets/PFP/VOXX_0152.webp",
    "https://example.com/upstream.webp",
    `/api/nft-image/0x${"2".repeat(64)}`
  ]);
  expect(paths.canvasSources).toEqual([
    "/assets/PFP/VOXX_0152.webp",
    `/api/nft-image/0x${"2".repeat(64)}`,
    "https://example.com/upstream.webp"
  ]);
  expect(paths.escapedMarkup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(paths.escapedMarkup).not.toContain("<script>");
  expect(paths.escapedMarkup).not.toContain("javascript:");

  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "pfp-fallback-fixture";
    fixture.innerHTML = nftImageMarkup({
      number:"152",
      name:"Fallback NFT",
      imageUrl:`${location.origin}/assets/PFP/VOXX_0007.webp`
    });
    document.body.appendChild(fixture);
  });
  const fallbackImage = page.locator("#pfp-fallback-fixture img");
  await expect(fallbackImage).toHaveAttribute("src", /VOXX_0007\.webp$/);
  await expect(fallbackImage).toHaveJSProperty("naturalWidth", 512);
});

test("wallet gate, NFT start and first decision work", async ({ page }) => {
  await mockWallet(page);
  await mockApis(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name:"BEGIN SIMULATION" })).toBeVisible();
  await expect(page.locator("#log")).not.toContainText("candidate");
  await page.getByRole("button", { name:"BEGIN SIMULATION" }).click();
  await page.getByRole("button", { name:"CONNECT SUI WALLET" }).click();
  await page.getByRole("button", { name:"TEST SUI WALLET" }).click();
  const candidateImage = page.locator(".nft-option img");
  await expect(candidateImage).toHaveAttribute("src", "/assets/PFP/VOXX_0007.webp");
  await expect(candidateImage).toHaveJSProperty("naturalWidth", 512);
  await page.getByRole("button", { name:/CANDIDATE #7/ }).click();
  await page.getByRole("button", { name:/BEGIN SIMULATION — USE ONLY ATTEMPT/ }).click();
  await expect(page.locator("#log")).toContainText("CASE 01", { timeout:10_000 });
  await expect(page.locator(".candidate-nft img")).toHaveAttribute("src", "/assets/PFP/VOXX_0007.webp");
  await page.locator(".choice-btn").first().click();
  await page.getByRole("button", { name:"SUBMIT DECISION" }).click();
  await expect(page.locator("#log")).toContainText("DECISION RECORDED");
});

test("hidden seven-click ending reaches final and share preview", async ({ page }) => {
  await mockApis(page);
  await page.goto("/");
  await page.getByRole("button", { name:"BEGIN SIMULATION" }).click();
  const title = page.locator("#preWalletShortcut");
  for (let i=0; i<7; i++) await title.click();
  await page.getByRole("button", { name:"ACCEPTABLE VOSS CANDIDATE" }).click();
  await page.locator(".endingVideo video").evaluate(video => video.dispatchEvent(new Event("ended")));
  await expect(page.locator("#log")).toContainText("SERVER RESULT DISTRIBUTION", { timeout:30_000 });
  await page.getByRole("button", { name:"GENERATE SHARE CARD" }).click();
  await page.getByRole("button", { name:"GENERATE SHARE CARD" }).last().click();
  await expect(page.getByRole("heading", { name:"Share Card Preview" })).toBeVisible();
});

test("disconnect returns to the original landing screen", async ({ page }) => {
  await mockWallet(page);
  await mockApis(page);
  await page.goto("/");
  await page.getByRole("button", { name:"BEGIN SIMULATION" }).click();
  await page.getByRole("button", { name:"CONNECT SUI WALLET" }).click();
  await page.getByRole("button", { name:"TEST SUI WALLET" }).click();
  await page.getByRole("button", { name:"DISCONNECT WALLET" }).click();
  await expect(page.getByRole("button", { name:"BEGIN SIMULATION" })).toBeVisible();
});
