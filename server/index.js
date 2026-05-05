import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { logger } from './logger.js';
import { db } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { healthRouter } from './routes/health.js';
import { startPruneErrorsTimer } from './timers/pruneErrors.js';

runMigrations(db, { log: (m) => logger.info({ migrate: m }, 'migration applied') });

export function createApp() {
  const app = express();

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

  app.use('/healthz', healthRouter);
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
