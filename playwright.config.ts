import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1,
  use: { baseURL:'http://127.0.0.1:3000', viewport:{width:1440,height:960}, headless:true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined), args:['--no-sandbox'] },
    screenshot:'only-on-failure', trace:'retain-on-failure' },
  webServer: { command:'npm run dev',url:'http://127.0.0.1:3000/api/health',reuseExistingServer:!process.env.CI,timeout:30000 },
});
