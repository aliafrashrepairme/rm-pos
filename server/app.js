import cors from 'cors';
import express from 'express';
import { createRequireAuth, requirePasswordCurrent } from './middleware/auth.js';
import { barcodeRoutes } from './routes/barcode.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { errorHandler, notFound } from './middleware/errors.js';
import { createLoginLimiter } from './middleware/loginLimiter.js';
import { publicAuthRoutes, sessionRoutes } from './routes/auth.js';
import { createInvoiceExtractor } from './services/invoiceExtractor.js';
import { healthRoutes } from './routes/health.js';
import { posRoutes } from './routes/pos.js';
import { inventoryRoutes } from './routes/inventory.js';
import { invoiceScanRoutes } from './routes/invoiceScans.js';
import { categoryRoutes, productRoutes } from './routes/products.js';
import { customerRoutes } from './routes/customers.js';
import { purchaseRoutes } from './routes/purchases.js';
import { settingsRoutes } from './routes/settings.js';
import { supplierRoutes } from './routes/suppliers.js';
import { reportRoutes } from './routes/reports.js';
import { transactionRoutes } from './routes/transactions.js';
import { userRoutes } from './routes/users.js';

export function createApp({ config, authClient, database, limiter = createLoginLimiter(), extractor = createInvoiceExtractor(config) }) {
  const clients = { authClient, database, limiter, extractor };
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', healthRoutes(clients));
  app.use('/api/auth', publicAuthRoutes(clients));

  app.use('/api', createRequireAuth(clients), requirePasswordCurrent);
  app.use('/api/auth', sessionRoutes(clients));
  app.use('/api/dashboard', dashboardRoutes(clients));
  app.use('/api/products', productRoutes(clients));
  app.use('/api/categories', categoryRoutes(clients));
  app.use('/api/inventory', inventoryRoutes(clients));
  app.use('/api/barcode', barcodeRoutes(clients));
  app.use('/api/pos', posRoutes(clients));
  app.use('/api/transactions', transactionRoutes(clients));
  app.use('/api/purchases', purchaseRoutes(clients));
  app.use('/api/suppliers', supplierRoutes(clients));
  app.use('/api/customers', customerRoutes(clients));
  app.use('/api/settings', settingsRoutes(clients));
  app.use('/api/invoice-scans', invoiceScanRoutes(clients));
  app.use('/api/reports', reportRoutes(clients));
  app.use('/api/users', userRoutes(clients));

  app.use('/api', notFound);
  app.use(errorHandler);
  return app;
}
