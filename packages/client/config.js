/* Where the CLI keeps the workspace URL and API key, shared with the MCP server:
   $XDG_CONFIG_HOME/sudo-sapient/config.json (default ~/.config), readable only by its owner.
   SUDO_URL and SUDO_API_KEY override it. `insecure`: the person allowed plain http to the saved URL
   (`login --insecure`); it doesn't carry over to a SUDO_URL. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const configPath = (env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sudo-sapient', 'config.json');

export function loadConfig(env = process.env) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath(env), 'utf8'));
  } catch {
    /* not logged in yet */
  }
  return { url: env.SUDO_URL || file.url || '', key: env.SUDO_API_KEY || file.key || '', insecure: !env.SUDO_URL && !!file.insecure };
}

/* The key is never readable by anyone else, not even for a moment: the directory is made (or made
   again) owner-only, and the file is written to a new temporary file created 0600, then renamed over
   the old one, so it is never a file that had wider permissions, and a crash can't leave half of it. */
export function saveConfig(cfg, env = process.env) {
  const file = configPath(env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.config.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(cfg, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

export function clearConfig(env = process.env) {
  fs.rmSync(configPath(env), { force: true });
}
