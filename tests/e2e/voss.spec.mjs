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

test("wallet gate, NFT start and first decision work", async ({ page }) => {
  await mockWallet(page);
  await mockApis(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name:"BEGIN SIMULATION" })).toBeVisible();
  await expect(page.locator("#log")).not.toContainText("candidate");
  await page.getByRole("button", { name:"BEGIN SIMULATION" }).click();
  await page.getByRole("button", { name:"CONNECT SUI WALLET" }).click();
  await page.getByRole("button", { name:"TEST SUI WALLET" }).click();
  await page.getByRole("button", { name:/CANDIDATE #7/ }).click();
  await page.getByRole("button", { name:/BEGIN SIMULATION — USE ONLY ATTEMPT/ }).click();
  await expect(page.locator("#log")).toContainText("CASE 01", { timeout:10_000 });
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
