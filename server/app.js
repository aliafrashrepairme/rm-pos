import cors from 'cors';
import express from 'express';
import { createRequireAuth, requirePasswordCurrent } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createLoginLimiter } from './middleware/loginLimiter.js';
import { publicAuthRoutes, sessionRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { reportRoutes } from './routes/reports.js';
import { userRoutes } from './routes/users.js';

export function createApp({ config, authClient, database, limiter = createLoginLimiter() }) {
  const clients = { authClient, database, limiter };
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRoutes(clients));
  app.use('/api/auth', publicAuthRoutes(clients));

  app.use('/api', createRequireAuth(clients), requirePasswordCurrent);
  app.use('/api/auth', sessionRoutes(clients));
  app.use('/api/reports', reportRoutes(clients));
  app.use('/api/users', userRoutes(clients));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
