/* MCP over stdio: newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr only. */
import readline from 'node:readline';

export function serveStdio(mcp, { input = process.stdin, output = process.stdout } = {}) {
  const s = {};
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const send = m => output.write(JSON.stringify(m) + '\n');
  // Requests are answered in order, so a slow call can't reorder replies to a client that expects it.
  let queue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    queue = queue.then(async () => {
      const msgs = Array.isArray(msg) ? msg : [msg];
      const out = (await Promise.all(msgs.map(m => mcp.handle(m, s)))).filter(Boolean);
      if (out.length) send(Array.isArray(msg) ? out : out[0]);
    });
  });
  return new Promise(resolve => rl.on('close', () => queue.then(resolve)));
}
