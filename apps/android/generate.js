/* Regenerates the Android project in this folder from twa-manifest.json with Bubblewrap:

     node apps/android/generate.js

   Run it after changing twa-manifest.json, the icons in public/icons, or the Bubblewrap version
   below, and commit what changes. build.sh also runs it, into a copy, for test builds:
   `--out <dir> --host <host> --package-id <id> --name <name>` generate that copy for another
   origin and identity without touching the committed files.

   The icons are read from this checkout's public/ (served on 127.0.0.1 while Bubblewrap runs), not
   from the deployed site, so the app gets the icons of the commit it's built from. The URLs in
   twa-manifest.json name where those files are published; only their path is used here.

   Bubblewrap regenerates the whole project and has no setting for two things we need, so they're
   added after it runs:
   - res/values-night/colors.xml: the splash screen background in dark mode (Bubblewrap has one
     splash colour), so the splash matches the page in both themes.
   - its Play Store icon and manifest checksum are removed: we don't use Play or `bubblewrap build`. */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUBBLEWRAP = '@bubblewrap/cli@1.27.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');
const TYPES = { '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

function parseArgs(argv) {
  const opts = { out: HERE };
  const names = { '--out': 'out', '--host': 'host', '--package-id': 'packageId', '--name': 'name' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (!key || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    opts[key] = argv[++i];
  }
  opts.out = path.resolve(opts.out);
  return opts;
}

/** Serves public/ on 127.0.0.1 at a free port; resolves to the server once it's listening. */
function servePublic() {
  const server = http.createServer((req, res) => {
    const file = path.join(PUBLIC, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    const type = TYPES[path.extname(file)];
    if (!file.startsWith(PUBLIC + path.sep) || !type || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const opts = parseArgs(process.argv.slice(2));
const twa = JSON.parse(fs.readFileSync(path.join(HERE, 'twa-manifest.json'), 'utf8'));
const published = `https://${twa.host}/`;

const server = await servePublic();
const local = `http://127.0.0.1:${server.address().port}/`;
/** Where Bubblewrap fetches an icon from: the same path in this checkout's public/. */
const fromCheckout = url => {
  if (!url.startsWith(published)) throw new Error(`Icon ${url} is not under ${published}; keep icons in public/`);
  return local + url.slice(published.length);
};

// A test build opens another origin as another app, so its links and shortcuts go there too.
const host = opts.host || twa.host;
const onHost = url => (url.startsWith(published) ? `https://${host}/` + url.slice(published.length) : url);
const spec = {
  ...twa,
  host,
  packageId: opts.packageId || twa.packageId,
  name: opts.name || twa.name,
  launcherName: opts.name || twa.launcherName,
  iconUrl: fromCheckout(twa.iconUrl),
  maskableIconUrl: twa.maskableIconUrl && fromCheckout(twa.maskableIconUrl),
  monochromeIconUrl: twa.monochromeIconUrl && fromCheckout(twa.monochromeIconUrl),
  shortcuts: twa.shortcuts.map(s => ({
    ...s,
    url: onHost(s.url),
    chosenIconUrl: s.chosenIconUrl && fromCheckout(s.chosenIconUrl),
    chosenMaskableIconUrl: s.chosenMaskableIconUrl && fromCheckout(s.chosenMaskableIconUrl),
    chosenMonochromeIconUrl: s.chosenMonochromeIconUrl && fromCheckout(s.chosenMonochromeIconUrl),
  })),
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-twa-'));
try {
  fs.writeFileSync(path.join(tmp, 'twa-manifest.json'), JSON.stringify(spec, null, 2));
  // `update` doesn't use the JDK or SDK, but Bubblewrap asks for them when its config has none.
  // A config of our own keeps it from prompting and leaves ~/.bubblewrap alone.
  const jdkPath = process.env.JAVA_HOME || 'unused';
  const androidSdkPath = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || 'unused';
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ jdkPath, androidSdkPath }));

  const args = ['dlx', BUBBLEWRAP, 'update', '--skipVersionUpgrade'];
  args.push(`--manifest=${path.join(tmp, 'twa-manifest.json')}`, `--directory=${opts.out}`, `--config=${path.join(tmp, 'config.json')}`);
  // Asynchronous, so this process keeps answering Bubblewrap's icon requests while it runs.
  const code = await new Promise(resolve => spawn('pnpm', args, { stdio: 'inherit' }).on('exit', resolve));
  if (code !== 0) throw new Error(`Bubblewrap exited with ${code}`);
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const f of ['store_icon.png', 'manifest-checksum.txt']) fs.rmSync(path.join(opts.out, f), { force: true });
const night = path.join(opts.out, 'app/src/main/res/values-night');
fs.mkdirSync(night, { recursive: true });
fs.writeFileSync(
  path.join(night, 'colors.xml'),
  `<?xml version="1.0" encoding="utf-8"?>
<!-- Written by apps/android/generate.js, not Bubblewrap: the splash screen background in dark
     mode, themeColorDark in twa-manifest.json, so the splash matches the page in both themes. -->
<resources>
    <color name="backgroundColor">${twa.themeColorDark}</color>
</resources>
`,
);
console.info(`Generated ${spec.packageId} for https://${host} in ${opts.out}`);
