/**
 * Kept as the stable import path for registration scanning. The work now lives
 * in ./extract, which handles PDFs with and without a text layer, images and
 * pasted text -- see extract/index.js.
 */
export {
  extractFromFile,
  extractFromBuffer,
  extractFromText,
  parseRegistrationText,
  mergeExtractions,
  ocrStatus,
  closeOcr,
} from './extract/index.js';

export { toIsoDate } from './extract/parse.js';
