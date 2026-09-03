import zlib from 'node:zlib';

/**
 * A very small PDF reader, written for one job: getting the content of a
 * scanned or printed registration page out of a PDF without pulling in a
 * native dependency.
 *
 * Two things come out of a PDF here:
 *   - the text layer, if the PDF has one (a digitally produced page);
 *   - the embedded page images, if it does not (a scan, or a browser page
 *     sent through "Print to PDF"), which are then handed to OCR.
 *
 * It is deliberately forgiving: anything it cannot make sense of is skipped
 * rather than thrown, because a partial read still fills in half the form.
 */

const STREAM_RE = /(\d+)\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;

/** Every `N 0 obj << dict >> stream ... endstream` in the file. */
function* streams(buf) {
  const head = buf.toString('latin1');
  STREAM_RE.lastIndex = 0;
  let m;
  while ((m = STREAM_RE.exec(head)) !== null) {
    const start = m.index + m[0].length;
    const end = head.indexOf('endstream', start);
    if (end === -1) continue;
    yield { num: Number(m[1]), dict: m[2], raw: buf.subarray(start, end) };
  }
}

function inflate(raw) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync]) {
    try {
      return fn(raw);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Undo the PDF string escapes inside a ( ... ) literal. */
function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (simple[c] !== undefined) return simple[c];
    return String.fromCharCode(parseInt(c, 8));
  });
}

/**
 * Pull readable text out of a decompressed content stream by walking the text
 * showing operators (Tj, TJ, ', "). Positioning operators are used only to
 * decide where a line break belongs.
 */
function textFromContentStream(content) {
  const src = content.toString('latin1');
  const out = [];
  let line = [];

  // ( literal ) Tj    |    [ (a) -300 (b) ] TJ    |    ( ... ) '   |   ( ... ) "
  const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bT[Jj*]\b|\bTD\b|\bTd\b|\bET\b|'|"/g;
  let m;
  let pending = [];
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (tok.startsWith('(')) {
      pending.push(unescapePdfString(tok.slice(1, -1)));
    } else if (tok.startsWith('<')) {
      // Hex string: two hex digits per byte.
      const hex = tok.slice(1, -1).replace(/\s/g, '');
      let s = '';
      for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      pending.push(s);
    } else if (tok === 'Tj' || tok === 'TJ' || tok === "'" || tok === '"') {
      line.push(pending.join(''));
      pending = [];
      if (tok === "'" || tok === '"') {
        out.push(line.join(''));
        line = [];
      }
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
      if (line.length) {
        out.push(line.join(''));
        line = [];
      }
      pending = [];
    }
  }
  if (line.length) out.push(line.join(''));

  return out
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const num = (dict, key) => {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)`));
  return m ? Number(m[1]) : 0;
};

/**
 * Read a PDF.
 * @returns {{ text: string, hasTextLayer: boolean, images: Array<{buffer,mime,width,height}> }}
 */
export function readPdf(buf) {
  const texts = [];
  const images = [];

  for (const { dict, raw } of streams(buf)) {
    const isImage = /\/Subtype\s*\/Image/.test(dict);

    if (isImage) {
      // Only the codecs a browser or an OCR engine can take directly.
      if (/\/DCTDecode/.test(dict)) {
        images.push({
          buffer: Buffer.from(raw.subarray(0, trimTrailingEol(raw))),
          mime: 'image/jpeg',
          width: num(dict, 'Width'),
          height: num(dict, 'Height'),
        });
      } else if (/\/JPXDecode/.test(dict)) {
        images.push({
          buffer: Buffer.from(raw.subarray(0, trimTrailingEol(raw))),
          mime: 'image/jp2',
          width: num(dict, 'Width'),
          height: num(dict, 'Height'),
        });
      }
      continue;
    }

    // Content streams are either Flate-compressed or stored as-is. Anything
    // behind another filter is left alone.
    const flate = /\/FlateDecode/.test(dict);
    if (!flate && /\/Filter/.test(dict)) continue;
    const content = flate ? inflate(raw) : Buffer.from(raw);
    if (!content) continue;
    const t = textFromContentStream(content);
    if (t) texts.push(t);
  }

  // Biggest image first: on a "Print to PDF" page that is the page itself,
  // with logos and avatars trailing behind it.
  images.sort((a, b) => b.width * b.height - a.width * a.height);

  const text = texts.join('\n').trim();
  return { text, hasTextLayer: text.length > 20, images };
}

function trimTrailingEol(raw) {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end -= 1;
  return end;
}

export const isPdf = (buf) => buf.subarray(0, 5).toString('latin1') === '%PDF-';
