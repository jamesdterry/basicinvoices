import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { logger } from './logger.js';
import { db } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { clientsRouter } from './routes/clients.js';
import { projectsRouter } from './routes/projects.js';
import { timeEntriesRouter } from './routes/timeEntries.js';
import { usersRouter } from './routes/users.js';
import { csrf } from './middleware/csrf.js';
import { loadSessionFromCookie, gateAppShell } from './middleware/requireUser.js';
import { startPruneErrorsTimer } from './timers/pruneErrors.js';

runMigrations(db, { log: (m) => logger.info({ migrate: m }, 'migration applied') });

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(csrf);
  app.use(loadSessionFromCookie);

  app.use('/healthz', healthRouter);
  app.use('/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/time-entries', timeEntriesRouter);
  app.use('/api/users', usersRouter);

  // App-shell gating: only / and /index.html require a session. Everything
  // else under public/ (login.html, /lib/*, /views/*, css) stays open.
  app.get(['/', '/index.html'], gateAppShell, (_req, res) => {
    res.sendFile('index.html', { root: 'public' });
  });

  app.use(express.static('public', { index: false, extensions: ['html'] }));

  app.use((err, req, res, _next) => {
    logger.error({ err, route: req.originalUrl }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const app = createApp();
  if (!config.isTest) startPruneErrorsTimer();
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv, dbPath: config.dbPath },
      'basicinvoices listening'
    );
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      try {
        db.close();
      } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
