/* Start the API + built client on a throwaway database for the e2e suite. */
import fs from 'node:fs';

const dir = 'test-results/e2e-data';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: 'test',
  SERVE_STATIC: 'true',
  PORT: process.env.E2E_PORT || '8790',
  APP_URL: `http://127.0.0.1:${process.env.E2E_PORT || '8790'}`,
  DATABASE_PATH: `${dir}/db.sqlite`,
  UPLOAD_DIR: `${dir}/uploads`,
  DISABLE_RATE_LIMIT: 'true',
});
await import('../server/index.js');
