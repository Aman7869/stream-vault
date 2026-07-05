const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const logger = require('../config/logger');

const redisConfig = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  maxRetriesPerRequest: null,
};

const redisDisabled = process.env.DISABLE_REDIS === 'true' || process.env.REDIS_HOST === 'none';

let connection = null;
let redisConnected = false;

if (!redisDisabled) {
  try {
    connection = new IORedis({
      ...redisConfig,
      retryStrategy(times) {
        // Limit retry attempts or wait longer between retries to avoid spamming the log
        return Math.min(times * 500, 5000);
      }
    });

    connection.on('connect', () => {
      redisConnected = true;
      logger.info('Redis connection for queue established successfully.');
    });

    connection.on('error', (err) => {
      redisConnected = false;
      logger.warn('Redis queue connection issue (Queue will use direct fallback):', { error: err.message });
    });
  } catch (e) {
    logger.error('Failed to instantiate IORedis connection:', { error: e.message });
  }
} else {
  logger.info('Redis queue is explicitly disabled (DISABLE_REDIS=true or REDIS_HOST=none). Direct execution fallback will be used.');
}

const transcodingQueue = connection ? new Queue('transcoding', { connection }) : null;
if (transcodingQueue) {
  transcodingQueue.on('error', (err) => {
    logger.warn('Transcoding Queue connection issue:', { error: err.message });
  });
}

const notificationQueue = connection ? new Queue('notification', { connection }) : null;
if (notificationQueue) {
  notificationQueue.on('error', (err) => {
    logger.warn('Notification Queue connection issue:', { error: err.message });
  });
}

/**
 * Enqueue a video transcoding job (HLS, subtitles, and dubbing).
 * If Redis/Queue is down, runs the transcoding job directly in the background.
 * @param {string} name - Job name (e.g. 'transcode_movie', 'transcode_episode')
 * @param {object} data - Payload containing media parameters
 */
async function addTranscodingJob(name, data) {
  if (redisConnected && transcodingQueue) {
    try {
      const job = await transcodingQueue.add(name, data, {
        attempts: 3, // bullmq retries 3 times on failure
        backoff: {
          type: 'exponential',
          delay: 10000, // wait 10s before retry
        },
        removeOnComplete: true,
        removeOnFail: false,
      });
      logger.info('Transcoding job enqueued successfully', { jobId: job.id, jobName: name });
      return job;
    } catch (err) {
      logger.error('Failed to enqueue transcoding job, falling back to direct execution', { error: err.message });
    }
  }

  // Fallback to direct asynchronous execution
  logger.info('Redis/Queue is offline. Running transcoding job directly in the background...', { jobName: name });
  setTimeout(async () => {
    try {
      const { processTranscodingJob } = require('../../services/transcoding/workers/transcodingWorker');
      await processTranscodingJob(name, data);
    } catch (err) {
      logger.error('Direct transcoding execution failed', { error: err.message });
    }
  }, 0);

  return { id: `direct-transcode-${Date.now()}` };
}

/**
 * Enqueue a notification email or SMS.
 * If Redis/Queue is down, runs the notification job directly in the background.
 * @param {string} name - Job name (e.g. 'send_email', 'send_sms')
 * @param {object} data - Payload containing email parameters
 */
async function addNotificationJob(name, data) {
  if (redisConnected && notificationQueue) {
    try {
      const job = await notificationQueue.add(name, data, {
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000, // wait 5s before retry
        },
        removeOnComplete: true,
        removeOnFail: false,
      });
      logger.info('Notification job enqueued successfully', { jobId: job.id, jobName: name });
      return job;
    } catch (err) {
      logger.error('Failed to enqueue notification job, falling back to direct execution', { error: err.message });
    }
  }

  // Fallback to direct asynchronous execution
  logger.info('Redis/Queue is offline. Running notification job directly in the background...', { jobName: name });
  setTimeout(async () => {
    try {
      const { processNotificationJob } = require('../../services/notification/workers/notificationWorker');
      await processNotificationJob(name, data);
    } catch (err) {
      logger.error('Direct notification execution failed', { error: err.message });
    }
  }, 0);

  return { id: `direct-notification-${Date.now()}` };
}

module.exports = {
  transcodingQueue,
  notificationQueue,
  addTranscodingJob,
  addNotificationJob,
};
