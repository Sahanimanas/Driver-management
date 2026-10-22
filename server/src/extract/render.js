import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { groupLines } from './layout.js';

/**
 * Reading a PDF page by page with pdf.js.
 *
 * Each page comes back either as words read off its text layer, or -- when it
 * has none worth the name -- as a picture of the page for OCR. "Worth the name"
 * matters: the client portal's "Print to PDF" pages draw their text as vector
 * shapes, so pdf.js finds no text at all and the only way to read them is to
 * render the page and hand it to Tesseract.
 *
 * Rendering the whole page, rather than pulling the embedded images out of it,
 * is what makes a page like the portal's registration popup readable: the
 * popup is drawn over a screenshot of the driver list, and the largest
 * embedded image is that list, not the popup.
 *
 * pdf.js and its canvas are loaded lazily; if either is missing this returns
 * null and the caller falls back to the small built-in reader in ./pdf.js.
 */

const require = createRequire(import.meta.url);

/** Pages rendered for OCR at about 300 dpi -- Tesseract's sweet spot. */
const OCR_SCALE = 300 / 72;
/** ...but never larger than this on the long side, to bound memory. */
const MAX_RENDER_PX = 4200;
/** A text layer with fewer letters and digits than this is not a text layer. */
const MIN_TEXT_CHARS = 20;

let libs = null;

async function load() {
  if (libs !== null) return libs;
  try {
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const pdfjs = await import(pathToFileURL(path.join(root, 'legacy', 'build', 'pdf.mjs')).href);
    const { createCanvas } = await import('@napi-rs/canvas');
    // pdf.js wants its asset folders as forward-slashed paths ending in '/'.
    const dir = (name) => `${path.join(root, name).replace(/\\/g, '/')}/`;
    libs = {
      pdfjs,
      createCanvas,
      assets: {
        standardFontDataUrl: dir('standard_fonts'),
        cMapUrl: dir('cmaps'),
        cMapPacked: true,
        wasmUrl: dir('wasm'),
      },
    };
  } catch (err) {
    console.warn('[pdf] pdf.js unavailable, using the built-in reader:', err.message);
    libs = false;
  }
  return libs;
}

/**
 * @returns {Promise<null | {
 *   numPages: number,
 *   pages: Array<{ number: number, text: string, words: Array, png: Buffer|null }>
 * }>}  null when pdf.js cannot be loaded
 */
export async function readPdfPages(buf, { maxPages = 4 } = {}) {
  const lib = await load();
  if (!lib) return null;

  const doc = await lib.pdfjs.getDocument({
    data: new Uint8Array(buf),
    ...lib.assets,
    // These are uploads from outside; never let a font program run as code.
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  try {
    const pages = [];
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n += 1) {
      const page = await doc.getPage(n);
      const { words, text } = await textLayer(page);

      if ((text.match(/[A-Za-z0-9]/g) || []).length >= MIN_TEXT_CHARS) {
        pages.push({ number: n, text, words, png: null });
      } else {
        pages.push({ number: n, text: '', words: [], png: await renderPage(lib, page) });
      }
      page.cleanup();
    }
    return { numPages: doc.numPages, pages };
  } finally {
    await doc.destroy();
  }
}

/** The page's text layer as positioned words, top-left origin, in points. */
async function textLayer(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const words = [];

  for (const item of content.items) {
    if (!item.str || !item.str.trim()) continue;
    const [, , c, d, e, f] = item.transform;
    const size = Math.hypot(c, d) || item.height || 10;
    const [x, baseline] = viewport.convertToViewportPoint(e, f);
    const charW = item.width / item.str.length;

    // One item is often a whole phrase ("SHYAM SINGH"); split it into words,
    // placing each by its share of the item's width.
    const re = /\S+/g;
    let m;
    while ((m = re.exec(item.str)) !== null) {
      words.push({
        text: m[0],
        x0: x + m.index * charW,
        x1: x + (m.index + m[0].length) * charW,
        y0: baseline - size,
        y1: baseline,
      });
    }
  }

  // Plain text in reading order, for the raw-text view and the generic rules.
  const text = groupLines(words).map((l) => l.words.map((w) => w.text).join(' ')).join('\n');
  return { words, text };
}

async function renderPage(lib, page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_SCALE, MAX_RENDER_PX / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });

  const canvas = lib.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  // OCR wants dark text on white; a PDF page has no background of its own.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvas.toBuffer('image/png');
}
