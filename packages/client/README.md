# @sudosapient/client

The small fetch client that [`@sudosapient/cli`](../cli) and [`@sudosapient/mcp`](../mcp) use to talk
to a Sudo Sapient workspace's public API (`/api/v1`), plus the config file they share. It has no
dependencies and runs on any `fetch` (Node 22 or later). It is a library, not a command; you get it
with the CLI or the MCP server, or on its own:

```bash
npm install @sudosapient/client
```

```js
import { createClient, ApiError } from '@sudosapient/client';

const api = createClient({ url: 'https://sudo.example.com', key: process.env.SUDO_API_KEY, client: 'My script' });
try {
  const me = await api.get('/me');
  const mine = await api.all('/tasks', { assignee: 'me', status: 'open' });
  await api.post('/tasks', { project: 'WEB', title: 'Fix login bug' });
} catch (e) {
  if (e instanceof ApiError) console.error(e.status, e.code, e.message);
}
```

- `createClient({ url, key, client, fetch })`: `get`, `post`, `patch`, `request`, and `all` (every
  page of a list endpoint). `client` labels your changes in Activity ("Ada via My script"). Errors
  are `ApiError` with `status`, `code` and `field`.
- `plainHttpRemote(url)`: true when the URL would send the key unencrypted to another machine.
- `@sudosapient/client/config`: `loadConfig`, `saveConfig`, `clearConfig` and `configPath` for
  `$XDG_CONFIG_HOME/sudo-sapient/config.json`, the file `sudo-cli login` writes (readable only by
  you; `SUDO_URL` and `SUDO_API_KEY` override it).

Endpoints, fields and errors are in the workspace's API reference (`/api/docs`) and in
[docs/api.md](../../docs/api.md).

## License

UNLICENSED, all rights reserved. The package is public on npm so anyone can install and use it, but
no license to copy, modify or redistribute the code is granted.
