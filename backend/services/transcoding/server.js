const path = require('path');
// Load microservice .env, then fall back to root .env
require('dotenv').config({ path: path.resolve(__dirname, './.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const IORedis = require('ioredis');
const logger = require('../../src/config/logger');
const { sequelize } = require('../../src/models');
const { initTranscodingWorker } = require('./workers/transcodingWorker');

const PORT = parseInt(process.env.PORT, 10) || 5001;
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379;

const app = express();
app.use(express.json());

// Simple healthcheck route
app.get('/health', async (req, res) => {
  try {
    await sequelize.authenticate();
    return res.json({
      status: 'healthy',
      service: 'transcoding-service',
      database: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      status: 'unhealthy',
      service: 'transcoding-service',
      database: 'error',
      error: err.message,
    });
  }
});

const startService = async () => {
  try {
    // 1. Establish DB Connection
    await sequelize.authenticate();
    logger.info('[Transcoding Service] Database connection established successfully');

    const redisDisabled = process.env.DISABLE_REDIS === 'true' || process.env.REDIS_HOST === 'none';

    if (redisDisabled) {
      logger.info('[Transcoding Service] Redis is disabled (DISABLE_REDIS=true). Worker not initialized.');
      app.listen(PORT, () => {
        logger.info(`[Transcoding Service] Health server running on http://localhost:${PORT}`);
      });
      return;
    }

    // 2. Establish Redis Connection
    const redisConnection = new IORedis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      maxRetriesPerRequest: null,
    });

    redisConnection.on('connect', () => {
      logger.info('[Transcoding Service] Redis connection established successfully');
    });

    redisConnection.on('error', (err) => {
      logger.error('[Transcoding Service] Redis connection error:', { error: err.message });
    });

    // 3. Start BullMQ Worker
    initTranscodingWorker(redisConnection);
    logger.info('[Transcoding Service] BullMQ Transcoding worker initialized');

    // 4. Start Healthcheck Server
    app.listen(PORT, () => {
      logger.info(`[Transcoding Service] Health server running on http://localhost:${PORT}`);
    });

    // Graceful Shutdown
    const shutdown = async (signal) => {
      logger.info(`[Transcoding Service] Received ${signal}. Shutting down gracefully...`);
      try {
        await redisConnection.quit();
        logger.info('[Transcoding Service] Redis client disconnected');
        await sequelize.close();
        logger.info('[Transcoding Service] Sequelize connection closed');
        process.exit(0);
      } catch (err) {
        logger.error('[Transcoding Service] Error during graceful shutdown:', { error: err.message });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (err) {
    logger.error('[Transcoding Service] Initialization failed:', { error: err.message, stack: err.stack });
    process.exit(1);
  }
};

startService();
