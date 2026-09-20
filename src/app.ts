import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { networkInterfaces } from 'os';

import { securityMiddleware } from './middleware/security';
import pitchRoutes from './routes/pitchRoutes';
import authRoutes from './routes/authRoutes';
import guestRoutes from './routes/guestRoutes';
import settingsRoutes from './routes/settingsRoutes';
import failureRoutes from './routes/failureRoutes';
import maintenanceRoutes from './routes/maintenanceRoutes';
import { closePool } from './utils/db';

dotenv.config();

// Fail fast at startup (not at first request) when JWT_SECRET is missing in a
// production build: the .env on the server is the single, stable source of the
// secret and must survive restarts and deployments untouched.
import { getJwtSecret } from './utils/jwtSecret';
getJwtSecret();

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3001,http://localhost:8080').split(',');

// ── Request logger (debug) ──────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  console.log(`[${req.method}] ${req.path}`);
  next();
});

app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, origin || true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: true,
}));
app.use(securityMiddleware);
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/pitch', pitchRoutes);
app.use('/api/guest', guestRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/failures', failureRoutes);
app.use('/api/maintenance', maintenanceRoutes);

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'BluePlugMobile API' });
});

app.use((req: Request, res: Response) => {
  console.error(`[404] ${req.method} ${req.originalUrl} — no route matched`);
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[500] ${req.method} ${req.originalUrl}:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  console.log(`BluePlugMobile API running on port ${PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use by another process.`);
    console.error(`  ─────────────────────────────────────────────`);
    console.error(`  To fix, find and kill the process:`);
    console.error(`    netstat -ano | findstr :${PORT}`);
    console.error(`    taskkill //PID <PID> //F`);
    console.error(`  Or use a different port:\n    PORT=${PORT + 1} npm start\n`);
    process.exit(1);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});

// Graceful shutdown: close the HTTP server and release the DB pool so
// connections don't leak into the next process on restart/deploy.
// Without this, MySQL connections accumulate past max_connections and
// every DB-backed route starts returning 500 with "Too many connections".
const shutdown = (signal: string) => {
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  server.close(() => {
    closePool()
      .catch((err) => console.error('Error closing DB pool:', err))
      .finally(() => process.exit(0));
  });
  // Force-exit if connections refuse to drain (e.g. long-running requests)
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
