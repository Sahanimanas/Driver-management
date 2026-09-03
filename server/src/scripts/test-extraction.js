/**
 * Registration data-extraction test harness.
 *
 *   npm run test:extraction                  -- run every document in testing_docs/
 *   npm run test:extraction -- path/to.pdf   -- run one file
 *
 * For each document it reports which engine read it, what came out, and -- if
 * an `<name>.expected.json` sits next to the document -- whether the fields
 * match. Expected files hold only the fields worth asserting on, so a partial
 * fixture is fine; anything absent from it is reported but not judged.
 *
 * Exit code is 1 if any assertion fails, so this can gate a build.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromFile, extractFromText, ocrStatus, closeOcr } from '../extract/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(here, '..', '..', '..', 'testing_docs');

const READABLE = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.txt']);

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
};

function targets() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  if (args.length) return args.map((a) => path.resolve(a));
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(`No testing_docs directory at ${DOCS_DIR}`);
    return [];
  }
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => READABLE.has(path.extname(f).toLowerCase()) && !f.endsWith('.expected.json'))
    .map((f) => path.join(DOCS_DIR, f));
}

function expectationsFor(file) {
  const side = `${file.replace(/\.[^.]+$/, '')}.expected.json`;
  if (!fs.existsSync(side)) return null;
  try {
    return JSON.parse(fs.readFileSync(side, 'utf8'));
  } catch (err) {
    console.error(`  could not read ${path.basename(side)}: ${err.message}`);
    return null;
  }
}

const norm = (v) => (v === null || v === undefined ? '' : String(v).toLowerCase().replace(/\s+/g, ' ').trim());

async function run() {
  const files = targets();
  if (!files.length) {
    console.log('Nothing to test.');
    return 0;
  }

  const status = ocrStatus();
  console.log(c.bold('\nRegistration data extraction\n'));
  console.log(`  OCR engines   remote: ${status.remote ? 'configured' : 'not configured'}`
    + `   local: ${status.local ? `available (${status.languages})` : 'not installed'}`);
  console.log(`  documents     ${files.length} in ${path.relative(process.cwd(), DOCS_DIR) || DOCS_DIR}\n`);

  let failures = 0;
  let checked = 0;

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const started = Date.now();
    console.log(c.bold(`  ${path.basename(file)}`));

    let result;
    try {
      result = ext === '.txt'
        ? extractFromText(fs.readFileSync(file, 'utf8'), path.basename(file))
        : await extractFromFile(file, MIME[ext], path.basename(file));
    } catch (err) {
      failures += 1;
      console.log(`    ${c.red('error')} ${err.message}\n`);
      continue;
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(c.dim(`    engine ${result.engine}   ${result.docTypes.join(', ') || 'unknown'}   ${secs}s`));
    result.pages.forEach((p) => {
      const conf = p.confidence == null ? '' : `, ${Math.round(p.confidence)}% confidence`;
      console.log(c.dim(`    · ${p.source} — ${p.characters} chars${conf}, ${p.matched} field(s)`));
    });
    if (result.note) console.log(`    ${c.yellow('note')} ${result.note}`);

    const entries = Object.entries(result.fields);
    if (!entries.length) {
      console.log(c.dim('    no fields extracted'));
    }
    entries.forEach(([k, v]) => {
      const shown = Array.isArray(v) ? v.map((r) => `${r.relation}: ${r.name} ${r.phone}`).join('; ') : v;
      console.log(`    ${k.padEnd(18)} ${shown}   ${c.dim(`[${result.confidence[k]}]`)}`);
    });

    if (result.rows?.length) {
      console.log(c.dim(`    ${result.rows.length} driver row(s) on the page:`));
      result.rows.slice(0, 8).forEach((r) => {
        const cut = r.nameTruncated ? c.yellow(' (name cut off on the page)') : '';
        console.log(`      ${r.registered_no.padEnd(14)} ${r.name}${cut}`);
      });
      if (result.rows.length > 8) console.log(c.dim(`      ... and ${result.rows.length - 8} more`));
    }

    const expected = expectationsFor(file);
    if (expected) {
      console.log(c.dim('    --- expectations ---'));
      for (const [k, want] of Object.entries(expected)) {
        // `rows` is asserted on by name, since the page order is what matters.
        if (k === 'rows') {
          const got = (result.rows || []).map((r) => r.name);
          want.forEach((name) => {
            checked += 1;
            if (got.some((g) => norm(g) === norm(name))) {
              console.log(`    ${c.green('pass')} row "${name}" found`);
            } else {
              failures += 1;
              console.log(`    ${c.red('FAIL')} row "${name}" not found among ${got.length} row(s)`);
            }
          });
          continue;
        }
        if (k === 'rowCount') {
          checked += 1;
          const got = (result.rows || []).length;
          if (got === want) console.log(`    ${c.green('pass')} rowCount = ${want}`);
          else {
            failures += 1;
            console.log(`    ${c.red('FAIL')} rowCount: expected ${want}, got ${got}`);
          }
          continue;
        }
        if (k === 'docType') {
          checked += 1;
          if (result.docTypes.includes(want)) console.log(`    ${c.green('pass')} docType includes ${want}`);
          else {
            failures += 1;
            console.log(`    ${c.red('FAIL')} docType: expected ${want}, got ${result.docTypes.join(', ')}`);
          }
          continue;
        }

        checked += 1;
        const got = result.fields[k];
        const ok = Array.isArray(want)
          ? JSON.stringify(want) === JSON.stringify(got)
          : norm(want) === norm(got);
        if (ok) {
          console.log(`    ${c.green('pass')} ${k} = ${want}`);
        } else {
          failures += 1;
          console.log(`    ${c.red('FAIL')} ${k}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got ?? null)}`);
        }
      }
    }
    console.log();
  }

  await closeOcr();

  if (!checked) {
    console.log(c.dim('  No .expected.json fixtures found — this was a report, not a test.\n'));
    return failures ? 1 : 0;
  }
  if (failures) {
    console.log(c.red(`  ${failures} failure(s) across ${checked} assertion(s).\n`));
    return 1;
  }
  console.log(c.green(`  All ${checked} assertion(s) passed.\n`));
  return 0;
}

run().then((code) => process.exit(code));
