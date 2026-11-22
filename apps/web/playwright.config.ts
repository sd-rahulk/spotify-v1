import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./e2e',timeout:180000,workers:1,
  use:{baseURL:'http://localhost:3000',browserName:'chromium',trace:'retain-on-failure'},
  webServer:[{command:'pnpm --filter @resonant/api exec tsx test/start-local.ts',url:'http://localhost:4100/health',cwd:'../..',timeout:120000,reuseExistingServer:true},
    {command:'pnpm dev',url:'http://localhost:3000',timeout:120000,reuseExistingServer:true}],
});
