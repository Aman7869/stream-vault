const path = require('path');
// Load microservice .env, then fall back to root .env
require('dotenv').config({ path: path.resolve(__dirname, './.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const IORedis = require('ioredis');
const logger = require('../../src/config/logger');
const { initNotificationWorker } = require('./workers/notificationWorker');

const PORT = parseInt(process.env.PORT, 10) || 5002;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;

const app = express();
app.use(express.json());

// Simple healthcheck route
app.get('/health', async (req, res) => {
  return res.json({
    status: 'healthy',
    service: 'notification-service',
    timestamp: new Date().toISOString(),
  });
});

const startService = async () => {
  try {
    const redisDisabled = process.env.DISABLE_REDIS === 'true' || process.env.REDIS_HOST === 'none';

    if (redisDisabled) {
      logger.info('[Notification Service] Redis is disabled (DISABLE_REDIS=true). Worker not initialized.');
      app.listen(PORT, () => {
        logger.info(`[Notification Service] Health server running on http://localhost:${PORT}`);
      });
      return;
    }

    // Establish Redis Connection
    const redisConnection = new IORedis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    });

    redisConnection.on('connect', () => {
      logger.info('[Notification Service] Redis connection established successfully');
    });

    redisConnection.on('error', (err) => {
      logger.error('[Notification Service] Redis connection error:', { error: err.message });
    });

    // Start BullMQ Worker
    initNotificationWorker(redisConnection);
    logger.info('[Notification Service] BullMQ Notification worker initialized');

    // Start Healthcheck Server
    app.listen(PORT, () => {
      logger.info(`[Notification Service] Health server running on http://localhost:${PORT}`);
    });

    // Graceful Shutdown
    const shutdown = async (signal) => {
      logger.info(`[Notification Service] Received ${signal}. Shutting down gracefully...`);
      try {
        await redisConnection.quit();
        logger.info('[Notification Service] Redis client disconnected');
        process.exit(0);
      } catch (err) {
        logger.error('[Notification Service] Error during graceful shutdown:', { error: err.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('[Notification Service] Initialization failed:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};

startService();
