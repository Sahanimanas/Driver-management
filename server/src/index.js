import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { config } from './config.js';
import { HttpError } from './util.js';

import authRoutes from './routes/auth.js';
import driverRoutes from './routes/drivers.js';
import deploymentRoutes from './routes/deployments.js';
import attendanceRoutes from './routes/attendance.js';
import insuranceRoutes from './routes/insurance.js';
import advanceRoutes from './routes/advances.js';
import expenseRoutes from './routes/expenses.js';
import salaryRoutes from './routes/salary.js';
import salaryMasterRoutes from './routes/salary-master.js';
import settingsRoutes from './routes/settings.js';
import tallyRoutes from './routes/tally.js';
import messagingRoutes from './routes/messaging.js';
import miscRoutes from './routes/misc.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'quantum-driver-management' }));

app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/deployments', deploymentRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/advances', advanceRoutes);
app.use('/api/expenses', expenseRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/salary-master', salaryMasterRoutes);
app.use('/api/tally', tallyRoutes);
app.use('/api/messaging', messagingRoutes);
app.use('/api', settingsRoutes);
app.use('/api', miscRoutes);

// Serve the built SPA when it exists (production single-origin deployment).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
}

app.use((req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next(new HttpError(404, `No such endpoint: ${req.method} ${req.path}`));
  }
  return next();
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${config.maxUploadMb} MB limit`
        : err.message;
    return res.status(400).json({ error: message, code: err.code });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(`[${req.method} ${req.path}]`, err);
  return res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server' : err.message,
    ...(err.details ? { details: err.details } : {}),
  });
});

app.listen(config.port, () => {
  console.log(`Quantum Driver Management API listening on http://localhost:${config.port}`);
  console.log(`  data: ${config.dataDir}`);
  console.log(`  whatsapp: ${config.whatsapp.enabled ? 'live (Cloud API)' : 'simulation mode'}`);
});
