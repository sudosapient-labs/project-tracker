/* Where the CLI keeps the workspace URL and API key, shared with the MCP server:
   $XDG_CONFIG_HOME/sudo-sapient/config.json (default ~/.config), readable only by its owner.
   SUDO_URL and SUDO_API_KEY override it. `insecure`: the person allowed plain http to the saved URL
   (`login --insecure`); it doesn't carry over to a SUDO_URL. */
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

export function saveConfig(cfg, env = process.env) {
  const file = configPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearConfig(env = process.env) {
  fs.rmSync(configPath(env), { force: true });
}
