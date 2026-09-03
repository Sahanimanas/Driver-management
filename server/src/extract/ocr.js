import { config } from '../config.js';

/**
 * Turning a picture of a page into text.
 *
 * Three engines are tried in order, and the first one that is available wins:
 *
 *   1. `remote`  -- whatever OCR_API_URL points at. Any service that takes a
 *                   multipart "file" and answers with JSON works; the usual
 *                   shapes ({text}, {ParsedText}, OCR.space, Google Vision)
 *                   are all understood.
 *   2. `local`   -- tesseract.js, which runs in-process. It is a normal
 *                   dependency but it is loaded lazily and its absence is not
 *                   an error, so the server still boots without it.
 *   3. `none`    -- nothing available; the caller falls back to asking the
 *                   supervisor to paste the text off the page.
 *
 * Every result carries the engine that produced it and a confidence, so the
 * registration form can tell the supervisor how much to trust the fill-in.
 */

let workerPromise = null;
let localUnavailable = false;

/**
 * Reject if `promise` has not settled in time.
 *
 * Both stages of the local engine can stall: starting it downloads the language
 * pack from a CDN on first use, and reading a very large page is unbounded
 * work. Neither has a timeout of its own, and a stalled one would leave the
 * supervisor watching a spinner with no way to know it had failed -- so the
 * wait is capped here and the caller falls back to pasting the page text.
 */
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function localWorker() {
  if (localUnavailable) return null;
  if (!workerPromise) {
    workerPromise = withTimeout(
      (async () => {
        const { createWorker } = await import('tesseract.js');
        // The language pack is a few MB and is fetched once, on first use. Keep
        // it with the rest of the runtime data, not in the working directory.
        return createWorker(config.ocr.languages, undefined, {
          cachePath: config.ocr.cacheDir,
        });
      })(),
      config.ocr.startupTimeoutMs,
      'Starting the local OCR engine',
    ).catch((err) => {
      // Don't make every later scan wait for the same failure.
      localUnavailable = true;
      workerPromise = null;
      console.warn('[ocr] local engine unavailable:', err.message);
      return null;
    });
  }
  return workerPromise;
}

/** Shut the local worker down cleanly (used by the test harness). */
export async function closeOcr() {
  const w = workerPromise ? await workerPromise : null;
  workerPromise = null;
  if (w) await w.terminate();
}

async function remoteOcr(buffer, mime, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), filename || 'scan');
  const res = await fetch(config.ocr.url, {
    method: 'POST',
    headers: config.ocr.key ? { Authorization: `Bearer ${config.ocr.key}` } : {},
    body: form,
    signal: AbortSignal.timeout(config.ocr.timeoutMs),
  });
  if (!res.ok) throw new Error(`OCR service returned HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  return { text: pickText(data), confidence: Number(data.confidence) || null };
}

/** Dig the text out of whichever JSON shape the service answered with. */
function pickText(data) {
  if (!data) return '';
  if (typeof data.text === 'string') return data.text;
  if (typeof data.ParsedText === 'string') return data.ParsedText;
  if (Array.isArray(data.ParsedResults)) {
    return data.ParsedResults.map((r) => r.ParsedText || '').join('\n');
  }
  // Google Vision style
  if (Array.isArray(data.responses)) {
    return data.responses.map((r) => r.fullTextAnnotation?.text || '').join('\n');
  }
  if (typeof data.result === 'string') return data.result;
  return '';
}

/**
 * Read one image.
 * @returns {Promise<{text: string, engine: string, confidence: number|null, error?: string}>}
 */
export async function ocrBuffer(buffer, mime, filename) {
  if (config.ocr.url) {
    try {
      const out = await remoteOcr(buffer, mime, filename);
      if (out.text.trim()) return { ...out, engine: 'remote' };
    } catch (err) {
      console.warn('[ocr] remote engine failed, falling back:', err.message);
    }
  }

  const worker = await localWorker();
  if (worker) {
    try {
      const { data } = await withTimeout(
        worker.recognize(buffer), config.ocr.timeoutMs, 'Reading the page',
      );
      return {
        text: data.text || '',
        engine: 'local',
        confidence: typeof data.confidence === 'number' ? data.confidence : null,
      };
    } catch (err) {
      console.warn('[ocr] local engine failed:', err.message);
      return { text: '', engine: 'none', confidence: null, error: err.message };
    }
  }

  return { text: '', engine: 'none', confidence: null };
}

/** Which engines this server can actually use right now. */
export function ocrStatus() {
  return {
    remote: Boolean(config.ocr.url),
    local: !localUnavailable,
    languages: config.ocr.languages,
  };
}
