import fs from 'node:fs';
import path from 'node:path';
import { readPdf, isPdf } from './pdf.js';
import { readPdfPages } from './render.js';
import { ocrBuffer, ocrStatus } from './ocr.js';
import { parseRegistrationText, mergeExtractions } from './parse.js';

export { parseRegistrationText, mergeExtractions, ocrStatus };
export { closeOcr } from './ocr.js';

/**
 * "Scan the client registration page to populate the fields of registration."
 *
 * One file in, a registration draft out. The route the file takes depends on
 * what it actually is:
 *
 *   PDF with a text layer  -> read the text straight off it (pdf.js). Exact.
 *   PDF without one        -> render each page and read it with Tesseract.
 *                             This is what a scan, or a browser page sent
 *                             through "Print to PDF", looks like. Without
 *                             pdf.js, the embedded page images are OCR'd.
 *   Image                  -> OCR it.
 *   Text pasted by hand    -> parse it as-is.
 *
 * Whatever happens, the caller gets back the fields, how each one was found,
 * the raw text, and an honest account of which engine did the reading -- so
 * that a page that could not be read says so instead of silently returning an
 * empty form.
 */

const IMAGE_MIME = /^image\//;

/** How many pages (or page images) of a PDF to read before calling it a day. */
const MAX_PDF_PAGES = 4;
const MAX_PDF_IMAGES = MAX_PDF_PAGES;

export async function extractFromFile(filePath, mime, originalName) {
  const buf = fs.readFileSync(filePath);
  const name = originalName || path.basename(filePath);
  return extractFromBuffer(buf, mime, name);
}

export async function extractFromBuffer(buf, mime, name = 'document') {
  const pages = [];
  let engine = 'none';
  let note = null;

  const pdfPages = isPdf(buf) || mime === 'application/pdf' ? await readPdfPages(buf, { maxPages: MAX_PDF_PAGES }) : null;

  if (pdfPages) {
    // Page by page: the text layer where there is one, otherwise the rendered
    // page read by OCR.
    for (const p of pdfPages.pages) {
      const where = pdfPages.numPages > 1 ? `page ${p.number}` : 'page';
      if (!p.png) {
        pages.push({ source: `${name} (${where}, text layer)`, text: p.text, words: p.words, engine: 'pdf-text', confidence: 100 });
        if (engine === 'none') engine = 'pdf-text';
        continue;
      }
      const out = await ocrBuffer(p.png, 'image/png', `${name}-p${p.number}.png`);
      if (out.engine !== 'none' || engine === 'none') engine = out.engine;
      if (out.text.trim()) {
        pages.push({
          source: `${name} (${where}, OCR)`,
          text: out.text,
          words: out.words,
          engine: out.engine,
          confidence: out.confidence,
        });
      }
    }
    if (!pages.length) {
      note =
        `${name} is a scanned PDF and no OCR engine was able to read it. `
        + 'Install the local engine (npm install in server/), point OCR_API_URL at a service, '
        + 'or paste the text from the page.';
    }
  } else if (isPdf(buf) || mime === 'application/pdf') {
    // pdf.js is not available: fall back to the built-in reader.
    const pdf = readPdf(buf);

    if (pdf.hasTextLayer) {
      pages.push({ source: `${name} (text layer)`, text: pdf.text, engine: 'pdf-text', confidence: 100 });
      engine = 'pdf-text';
    } else if (pdf.images.length) {
      // No text layer: this is a scan. Read the page images instead, largest
      // first -- on a printed page that is the page itself.
      const shortlist = pdf.images
        .filter((im) => im.width * im.height >= 40000)   // skip logos and avatars
        .slice(0, MAX_PDF_IMAGES);

      if (!shortlist.length) {
        note = `${name} has no text layer and no page-sized image could be read from it.`;
      }

      for (const [i, image] of shortlist.entries()) {
        const out = await ocrBuffer(image.buffer, image.mime, `${name}-p${i + 1}`);
        engine = out.engine;
        if (out.text.trim()) {
          pages.push({
            source: `${name} (page image ${i + 1}, ${image.width}x${image.height})`,
            text: out.text,
            engine: out.engine,
            confidence: out.confidence,
          });
        }
      }
      if (!pages.length && !note) {
        note =
          `${name} is a scanned PDF and no OCR engine was able to read it. `
          + 'Install the local engine (npm install in server/), point OCR_API_URL at a service, '
          + 'or paste the text from the page.';
      }
    } else {
      note = `${name} is a PDF with neither a text layer nor an embedded page image.`;
    }
  } else if (IMAGE_MIME.test(mime || '')) {
    const out = await ocrBuffer(buf, mime, name);
    engine = out.engine;
    if (out.text.trim()) {
      pages.push({ source: name, text: out.text, words: out.words, engine: out.engine, confidence: out.confidence });
    } else {
      note =
        `No text could be read from ${name}. `
        + (out.error ? `The OCR engine reported: ${out.error}. ` : '')
        + 'Paste the text from the page to fill the form instead.';
    }
  } else {
    // Plain text, CSV, anything else readable.
    const text = buf.toString('utf8');
    pages.push({ source: name, text, engine: 'text', confidence: 100 });
    engine = 'text';
  }

  return summarise(pages, { engine, note, name });
}

/** Parse pasted or typed text — no OCR involved. */
export function extractFromText(text, name = 'pasted text') {
  return summarise([{ source: name, text, engine: 'text', confidence: 100 }], {
    engine: 'text',
    name,
  });
}

function summarise(pages, { engine, note, name }) {
  const parsed = pages.map((p) => ({
    ...parseRegistrationText(p.text, { engine: p.engine, words: p.words }),
    source: p.source,
  }));
  const merged = mergeExtractions(parsed);

  // Rows found on a client page, de-duplicated across the pages of the file.
  const rows = [];
  const seenRows = new Set();
  parsed.forEach((p) => (p.rows || []).forEach((r) => {
    const key = `${r.registered_no}|${r.name}`.toLowerCase();
    if (seenRows.has(key)) return;
    seenRows.add(key);
    rows.push(r);
  }));

  return {
    ...merged,
    rows,
    engine,
    note: note || null,
    docTypes: [...new Set(parsed.map((p) => p.docType))],
    pages: pages.map((p, i) => ({
      source: p.source,
      engine: p.engine,
      confidence: p.confidence,
      docType: parsed[i].docType,
      matched: parsed[i].matched,
      characters: p.text.length,
    })),
    text: pages.map((p) => p.text).join('\n\n'),
    name,
  };
}
