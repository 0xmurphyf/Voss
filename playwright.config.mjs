import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir:"./tests/e2e",
  timeout:60_000,
  use:{ baseURL:"http://127.0.0.1:4173", headless:true },
  webServer:{
    command:"npm start",
    url:"http://127.0.0.1:4173",
    reuseExistingServer:true,
    timeout:20_000
  }
});
