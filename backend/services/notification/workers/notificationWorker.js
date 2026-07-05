const { Worker } = require('bullmq');
const nodemailer = require('nodemailer');
const logger = require('../../../src/config/logger');
const transporter = require('../providers/emailProvider');
const { sendSms } = require('../providers/smsProvider');
const { templates, FROM } = require('../templates/emailTemplates');

async function processNotificationJob(name, data) {
  if (name === 'send_email') {
    const { to, subject, html, text, attachments } = data;
    try {
      const info = await transporter.sendMail({
        from: FROM,
        to,
        subject,
        html,
        text,
        attachments,
      });
      logger.info('[Notification Worker] Generic email sent successfully', { to, subject, messageId: info.messageId });
      
      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) logger.info(`📬 Preview: ${previewUrl}`);

      return info;
    } catch (err) {
      logger.error('[Notification Worker] Failed to send generic email', { to, subject, error: err.message });
      throw err;
    }
  } else if (name === 'send_email_template') {
    const { template, to, data: templateData } = data;
    const templateFn = templates[template];

    if (!templateFn) {
      const err = new Error(`Email template "${template}" not found`);
      logger.error('[Notification Worker] Invalid template error', { template });
      throw err;
    }

    const emailPayload = templateFn(templateData);

    try {
      const info = await transporter.sendMail({
        from: FROM,
        to,
        subject: emailPayload.subject,
        html: emailPayload.html,
        text: emailPayload.text,
        attachments: emailPayload.attachments,
      });
      logger.info('[Notification Worker] Templated email sent successfully', { to, template, messageId: info.messageId });

      const previewUrl = nodemailer.getTestMessageUrl(info);
      if (previewUrl) logger.info(`📬 Preview: ${previewUrl}`);

      return info;
    } catch (err) {
      logger.error('[Notification Worker] Failed to send templated email', { to, template, error: err.message });
      throw err;
    }
  } else if (name === 'send_sms') {
    const { to, body } = data;
    try {
      const result = await sendSms(to, body);
      logger.info('[Notification Worker] SMS sent successfully', { to });
      return result;
    } catch (err) {
      logger.error('[Notification Worker] Failed to send SMS', { to, error: err.message });
      throw err;
    }
  }
}

function initNotificationWorker(redisConnection) {
  const worker = new Worker('notification', async (job) => {
    const { name, data } = job;
    logger.info(`[Notification Worker] Starting job ${job.id}: ${name}`);
    return processNotificationJob(name, data);
  }, {
    connection: redisConnection,
    concurrency: 5, // process up to 5 notifications in parallel
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Notification Worker] Job ${job.id} failed`, { error: err.message });
  });

  worker.on('error', (err) => {
    logger.error('[Notification Worker] BullMQ worker connection error:', { error: err.message });
  });

  return worker;
}

module.exports = { initNotificationWorker, processNotificationJob };
