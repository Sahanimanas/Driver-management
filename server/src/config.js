import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret-change-me',
  tokenTtl: process.env.TOKEN_TTL || '12h',
  dataDir: process.env.DATA_DIR || path.join(ROOT, 'data'),
  uploadDir: process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads'),
  webDist: path.resolve(ROOT, '..', 'web', 'dist'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15),

  // Business rules straight out of the scope document.
  rules: {
    expenseDirectorThreshold: Number(process.env.EXPENSE_DIRECTOR_THRESHOLD || 3000),
    netbankingMaxRequests: Number(process.env.NETBANKING_MAX_REQUESTS || 4),
    cutoffs: { NOON: '12:00', EVENING: '18:30' },
    // Attendance codes that are payable days for the wage register.
    payableCodes: { P: 1, T: 1, TA: 1, L: 0, LE: 0 },
  },

  // WhatsApp: uses the Meta Cloud API when credentials are present, otherwise
  // runs in simulation mode so the flow is fully testable without a provider.
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    get enabled() {
      return Boolean(this.token && this.phoneNumberId);
    },
  },

  // "Scan the registration page to populate the fields." A remote OCR service
  // is used when OCR_API_URL is set; otherwise the bundled local engine reads
  // the page in-process. Either way a PDF that already has a text layer is
  // read directly and never goes near OCR.
  ocr: {
    url: process.env.OCR_API_URL || '',
    key: process.env.OCR_API_KEY || '',
    timeoutMs: Number(process.env.OCR_TIMEOUT_MS || 60000),
    // Starting the local engine downloads its language pack on first use.
    startupTimeoutMs: Number(process.env.OCR_STARTUP_TIMEOUT_MS || 120000),
    // tesseract.js language packs, '+'-joined. 'eng' covers the client pages,
    // Aadhaar and licences; add 'hin' for Devanagari on Aadhaar cards.
    languages: process.env.OCR_LANGUAGES || 'eng',
    // Where the local engine keeps its downloaded language packs.
    cacheDir: process.env.OCR_CACHE_DIR
      || path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'ocr'),
  },

  // Branding. The client is supplying the trading name and the logo; both are
  // editable at runtime from Settings, and these are only the fallbacks.
  branding: {
    appName: process.env.APP_NAME || 'Quantum',
    tagline: process.env.APP_TAGLINE || 'Driver Attendance & Management',
  },
};

export const db_file = path.join(config.dataDir, 'quantum.db');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
// The local OCR engine caches its language packs here.
fs.mkdirSync(config.ocr.cacheDir, { recursive: true });
