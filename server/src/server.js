import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initDatabase } from './db/index.js';
import { customerAuth } from './middleware/auth.js';
import { HttpError } from './services/http.js';
import { convertWalletHandler } from './routes/account.js';
import accountRouter from './routes/account.js';
import adminRouter from './routes/admin.js';
import authRouter from './routes/auth.js';
import ordersRouter, { trackRouter } from './routes/orders.js';
import storefrontRouter from './routes/storefront.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const clientBuild = path.resolve(currentDirectory, '../../client/dist');
let initialized = false;

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة، يرجى المحاولة بعد قليل' },
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'محاولات تسجيل الدخول كثيرة، يرجى المحاولة بعد قليل' },
});

export function createApp({ initializeDatabase = true } = {}) {
  if (initializeDatabase && !initialized) {
    initDatabase();
    initialized = true;
  }
  const app = express();
  const configuredOrigins = (process.env.CORS_ORIGIN || '')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  if (process.env.NODE_ENV === 'production' && !configuredOrigins.length) {
    throw new Error('CORS_ORIGIN must be configured in production');
  }
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || !configuredOrigins.length) return callback(null, true);
      return callback(null, configuredOrigins.includes(origin));
    },
  }));
  app.use(express.json({ limit: '20mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(generalLimiter);

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/storefront', storefrontRouter);
  app.post('/api/auth/session', loginLimiter);
  app.use('/api/auth', authRouter);
  app.post('/api/admin/session', loginLimiter);
  app.post('/api/admin/login', loginLimiter);
  app.use('/api/admin', adminRouter);
  app.use('/api/account', accountRouter);
  app.post('/api/wallet/convert', customerAuth, convertWalletHandler);
  app.use('/api/orders', ordersRouter);
  app.use('/api/track', trackRouter);

  if (existsSync(clientBuild)) {
    app.use(express.static(clientBuild, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
    app.get(/^(?!\/api(?:\/|$)).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(clientBuild, 'index.html'), (error) => { if (error) next(error); });
    });
  }
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'المسار المطلوب غير موجود', 'not_found')));
  app.use((error, _req, res, _next) => {
    const status = Number(error.status || error.statusCode) || 500;
    if (status >= 500) console.error(error);
    const message = status >= 500 ? 'حدث خطأ غير متوقع، حاول مجدداً' : error.message;
    res.status(status).json({ error: message, code: error.code || (status === 500 ? 'internal_error' : 'request_error') });
  });
  return app;
}

export function startServer({ port = Number(process.env.PORT) || 3001, host = process.env.HOST || '0.0.0.0', ...appOptions } = {}) {
  const app = createApp(appOptions);
  const server = app.listen(port, host, () => console.log(`Quick Market API listening on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer();
}
