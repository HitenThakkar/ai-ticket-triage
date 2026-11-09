import express from 'express';
import config from '../config.js';
import { apiKeyAuth } from './middleware/apiKey.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { accessLog, requestId } from './middleware/requestContext.js';
import { ticketsRouter } from './routes/tickets.js';
import { healthRouter, usageRouter } from './routes/system.js';

export function createApp() {
  const app = express();

  // Behind a load balancer or `docker compose`, the client IP is in X-Forwarded-For.
  // Trusting one hop is right for the usual single-proxy deployment.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(express.json({ limit: config.http.bodyLimit }));

  // Health checks come before auth so probes do not need a key.
  app.use(healthRouter());

  app.use(apiKeyAuth(config.http.apiKeys));
  app.use(accessLog);

  app.use('/api/v1/tickets', ticketsRouter());
  app.use('/api/v1', usageRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
