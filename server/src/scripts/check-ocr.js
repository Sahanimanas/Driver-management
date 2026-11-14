/**
 * Can this machine read registration PDFs?  `npm run check:ocr`
 *
 * The scan path degrades quietly by design -- a missing piece falls back to a
 * weaker reader rather than crashing the server -- which also means a broken
 * install only shows up as "nothing could be read". This checks each piece in
 * turn and says which one is missing, and how to fix it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const ok = (m) => console.log(`\x1b[32m  OK  \x1b[0m ${m}`);
const bad = (m, fix) => {
  console.log(`\x1b[31m FAIL \x1b[0m ${m}`);
  if (fix) console.log(`        fix: ${fix}`);
  failures += 1;
};
let failures = 0;

console.log(`node ${process.version} at ${process.execPath}\n`);

// 1. pdf.js 5 needs a recent Node; on an older one its import fails and scans
//    of "Print to PDF" pages silently fall back to a reader that cannot do them.
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj > 22 || (maj === 22 && min >= 13)) ok('Node version is 22.13 or newer');
else bad(`Node ${process.version} is too old for pdf.js (needs 22.13+)`, 'install Node 22 LTS or 24, then restart pm2 (see SERVER_SETUP.md)');

// 2. pdf.js itself.
try {
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  await import(pathToFileURL(path.join(root, 'legacy', 'build', 'pdf.mjs')).href);
  ok('pdfjs-dist loads');
} catch (err) {
  bad(`pdfjs-dist does not load: ${err.message}`, 'cd server && npm install');
}

// 3. The native canvas pdf.js draws pages onto. Its binary is a per-platform
//    optional package, so it is the piece most likely to be missing on Linux.
try {
  const { createCanvas } = await import('@napi-rs/canvas');
  const c = createCanvas(10, 10);
  c.getContext('2d').fillRect(0, 0, 10, 10);
  c.toBuffer('image/png');
  ok('@napi-rs/canvas loads and renders');
} catch (err) {
  bad(
    `@napi-rs/canvas does not load: ${err.message}`,
    'cd server && rm -rf node_modules && npm install   (do not use --omit=optional / --no-optional)',
  );
}

// 4. Tesseract and its language pack.
const dir = config.ocr.cacheDir;
try {
  fs.accessSync(dir, fs.constants.W_OK);
  ok(`OCR cache folder is writable: ${dir}`);
} catch {
  bad(`OCR cache folder is not writable: ${dir}`, `chown/chmod it for the user pm2 runs as`);
}

const langs = config.ocr.languages.split('+');
const missing = langs.filter((l) => !fs.existsSync(path.join(dir, `${l}.traineddata`)));
if (missing.length) {
  console.log(`  ..   language pack(s) ${missing.join(', ')} not cached yet; downloading now (needs internet)`);
}

let worker;
try {
  const { createWorker } = await import('tesseract.js');
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 120s')), 120000));
  worker = await Promise.race([createWorker(config.ocr.languages, undefined, { cachePath: dir }), timeout]);
  ok(`Tesseract starts with language pack(s): ${config.ocr.languages}`);
} catch (err) {
  bad(
    `Tesseract does not start: ${err.message}`,
    `the server could not download the language pack. Copy eng.traineddata from a working machine into ${dir}`,
  );
} finally {
  if (worker) await worker.terminate();
}

console.log(
  failures
    ? `\n${failures} problem(s). Fix them, then: pm2 restart driver-mgmt-api --update-env`
    : '\nAll good. Run `npm run test:extraction` to read the sample documents end to end.\n'
      + 'If scans still fail in the app, pm2 may be using a different Node than this shell -- see SERVER_SETUP.md.',
);
process.exit(failures ? 1 : 0);
