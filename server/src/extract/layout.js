/**
 * Words on a page, with where they sit.
 *
 * A form laid out in columns ("Mobile No. : 7891217723   Phone No. :") cannot be
 * read reliably as a stream of text: OCR folds the columns together, and a
 * label that wraps onto two lines ("Aadhar / No.") lands on a different line
 * from its value. Keeping each word's box lets the parser look for a value to
 * the right of its label instead of trusting the line breaks.
 *
 * A word is { text, x0, y0, x1, y1 } with the origin at the top left. The units
 * do not matter -- PDF points, image pixels or character columns -- because
 * every distance is measured against the height of the words involved.
 */

export const height = (w) => Math.max(1, w.y1 - w.y0);
export const midY = (w) => (w.y0 + w.y1) / 2;

/**
 * Words from plain text, for pasted text and OCR services that return no
 * boxes: each line becomes a row and each character a column, which keeps
 * side-by-side columns apart well enough to read.
 */
export function wordsFromText(text) {
  const words = [];
  String(text || '').replace(/\r/g, '').split('\n').forEach((line, row) => {
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      words.push({ text: m[0], x0: m.index, x1: m.index + m[0].length, y0: row * 10, y1: row * 10 + 8 });
    }
  });
  return words;
}

/** Group words into lines, top to bottom, each line left to right. */
export function groupLines(words) {
  const sorted = [...words].sort((a, b) => midY(a) - midY(b) || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(midY(w) - line.y) <= 0.5 * Math.min(line.h, height(w))) {
      line.words.push(w);
      line.y = line.words.reduce((s, x) => s + midY(x), 0) / line.words.length;
    } else {
      lines.push({ y: midY(w), h: height(w), words: [w] });
    }
  }
  lines.forEach((l) => l.words.sort((a, b) => a.x0 - b.x0));
  return lines;
}
