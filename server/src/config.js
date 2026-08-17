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

  // Optional OCR endpoint used by "scan the registration page to populate the
  // fields". When unset the server falls back to the built-in text parser.
  ocr: {
    url: process.env.OCR_API_URL || '',
    key: process.env.OCR_API_KEY || '',
  },
};

export const db_file = path.join(config.dataDir, 'quantum.db');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });
