import cors from 'cors';
import express from 'express';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { publicAuthRoutes, sessionRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { reportRoutes } from './routes/reports.js';

export function createApp({ config, authClient, database }) {
  const clients = { authClient, database };
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRoutes(clients));
  app.use('/api/auth', publicAuthRoutes(clients));

  app.use('/api', createRequireAuth(clients));
  app.use('/api/auth', sessionRoutes());
  app.use('/api/reports', reportRoutes(clients));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
