const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const crypto = require('crypto');
const ffmpegPath = require('ffmpeg-static');
const logger = require('../../../src/config/logger');
const { Movie, Episode } = require('../../../src/models');
const { generateSubtitles } = require('../../../src/helpers/subtitleGenerator');
const { dubVideo } = require('../../../src/helpers/audioDubber');

ffmpeg.setFfmpegPath(ffmpegPath);

const UPLOADS_DIR = path.resolve(__dirname, '../../../uploads');
const HLS_DIR = path.join(UPLOADS_DIR, 'hls');

const QUALITIES = [
  { name: '360p',  height: 360,  width: 640,  videoBitrate: '800k',  audioBitrate: '96k',  bandwidth: 896000  },
  { name: '720p',  height: 720,  width: 1280, videoBitrate: '2500k', audioBitrate: '128k', bandwidth: 2628000 },
  { name: '1080p', height: 1080, width: 1920, videoBitrate: '5000k', audioBitrate: '192k', bandwidth: 5192000 },
];

function transcodeQuality(inputPath, qualityDir, quality) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(qualityDir, { recursive: true });

    // Generate 16-byte random key for HLS segment encryption
    const key = crypto.randomBytes(16);
    const keyPath = path.join(qualityDir, 'key.key');
    fs.writeFileSync(keyPath, key);

    // Write temporary key info file for FFmpeg
    const keyInfoPath = path.join(qualityDir, 'key_info.txt');
    const keyInfoContent = `key.key\n${keyPath}\n`;
    fs.writeFileSync(keyInfoPath, keyInfoContent);

    ffmpeg(inputPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .videoFilters(`scale=-2:${quality.height}`)
      .videoBitrate(quality.videoBitrate)
      .audioBitrate(quality.audioBitrate)
      .outputOptions([
        '-hls_time 6',
        '-hls_playlist_type vod',
        `-hls_segment_filename ${path.join(qualityDir, 'seg_%03d.ts')}`,
        `-hls_key_info_file ${keyInfoPath}`,
      ])
      .output(path.join(qualityDir, 'playlist.m3u8'))
      .on('end', () => {
        try {
          fs.unlinkSync(keyInfoPath);
        } catch {}
        resolve();
      })
      .on('error', (err) => {
        try {
          fs.unlinkSync(keyInfoPath);
        } catch {}
        reject(err);
      })
      .run();
  });
}

function buildMasterPlaylist() {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', ''];
  for (const q of QUALITIES) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${q.bandwidth},RESOLUTION=${q.width}x${q.height},NAME="${q.name}"`);
    lines.push(`${q.name}/playlist.m3u8`);
    lines.push('');
  }
  return lines.join('\n');
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:5000';

async function notifyGateway(type, id, status, extra = {}) {
  try {
    await axios.post(`${GATEWAY_URL}/api/v1/internal/transcode-complete`, {
      type,
      id,
      status,
      ...extra
    });
  } catch (err) {
    logger.error('[Transcoding Worker] Failed to notify gateway of transcode status', { type, id, status, error: err.message });
  }
}

async function processTranscodingJob(name, data) {
  if (name === 'transcode_movie') {
    const { movieId, inputPath, outputName, title, slug, generateSubtitles: runSubtitles } = data;
    const outputDir = path.join(HLS_DIR, outputName);

    try {
      // 1. Update status to processing
      await Movie.update({ transcoding_status: 'processing' }, { where: { id: movieId } });
      await notifyGateway('movie', movieId, 'processing');

      // 2. Perform HLS Transcoding for each quality
      fs.mkdirSync(outputDir, { recursive: true });
      for (const quality of QUALITIES) {
        logger.info(`[Transcoding Worker] Movie ${movieId} → ${quality.name}`);
        await transcodeQuality(inputPath, path.join(outputDir, quality.name), quality);
      }

      // Write master playlist
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), buildMasterPlaylist());
      const hlsUrl = `/uploads/hls/${outputName}/master.m3u8`;

      // 3. Subtitles & Audio Dubbing (optional)
      let subtitleUrl = null;
      let dubbedAudioUrl = null;

      if (runSubtitles) {
        try {
          subtitleUrl = await generateSubtitles(inputPath, title, slug);
          if (subtitleUrl) {
            const absoluteVttPath = path.resolve(__dirname, '../../../', subtitleUrl.replace(/^\//, ''));
            dubbedAudioUrl = await dubVideo(absoluteVttPath, slug);
          }
        } catch (subErr) {
          logger.error('[Transcoding Worker] Movie subtitles/dubbing failed, proceeding without them', { movieId, error: subErr.message });
        }
      }

      // Clean up raw upload (moved after subtitles/dubbing generation)
      try {
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
      } catch (unlinkErr) {
        logger.warn('[Transcoding Worker] Failed to delete raw video upload file:', { path: inputPath, error: unlinkErr.message });
      }

      // 4. Update status to completed
      const updateData = {
        video_url: hlsUrl,
        transcoding_status: 'completed',
      };
      if (subtitleUrl) updateData.subtitle_url = subtitleUrl;
      if (dubbedAudioUrl) updateData.dubbed_audio_url = dubbedAudioUrl;

      await Movie.update(updateData, { where: { id: movieId } });
      await notifyGateway('movie', movieId, 'completed');
      logger.info(`[Transcoding Worker] Movie ${movieId} transcoding completed successfully`);

    } catch (err) {
      logger.error(`[Transcoding Worker] Movie ${movieId} transcoding failed`, { error: err.message });
      await Movie.update({ transcoding_status: 'failed' }, { where: { id: movieId } });
      await notifyGateway('movie', movieId, 'failed', { error: err.message });
      throw err;
    }
  } else if (name === 'transcode_episode') {
    const { episodeId, inputPath, outputName, title, slug, generateSubtitles: runSubtitles } = data;
    const outputDir = path.join(HLS_DIR, outputName);

    try {
      // 1. Update status to processing
      await Episode.update({ transcoding_status: 'processing' }, { where: { id: episodeId } });
      await notifyGateway('episode', episodeId, 'processing');

      // 2. Perform HLS Transcoding for each quality
      fs.mkdirSync(outputDir, { recursive: true });
      for (const quality of QUALITIES) {
        logger.info(`[Transcoding Worker] Episode ${episodeId} → ${quality.name}`);
        await transcodeQuality(inputPath, path.join(outputDir, quality.name), quality);
      }

      // Write master playlist
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), buildMasterPlaylist());
      const hlsUrl = `/uploads/hls/${outputName}/master.m3u8`;

      // 3. Subtitles & Audio Dubbing
      let subtitleUrl = null;
      let dubbedAudioUrl = null;

      if (runSubtitles) {
        try {
          subtitleUrl = await generateSubtitles(inputPath, title, slug);
          if (subtitleUrl) {
            const absoluteVttPath = path.resolve(__dirname, '../../../', subtitleUrl.replace(/^\//, ''));
            dubbedAudioUrl = await dubVideo(absoluteVttPath, slug);
          }
        } catch (subErr) {
          logger.error('[Transcoding Worker] Episode subtitles/dubbing failed, proceeding without them', { episodeId, error: subErr.message });
        }
      }

      // Clean up raw upload (moved after subtitles/dubbing generation)
      try {
        if (fs.existsSync(inputPath)) {
          fs.unlinkSync(inputPath);
        }
      } catch (unlinkErr) {
        logger.warn('[Transcoding Worker] Failed to delete raw video upload file:', { path: inputPath, error: unlinkErr.message });
      }

      // 4. Update status to completed
      const updateData = {
        video_url: hlsUrl,
        transcoding_status: 'completed',
      };
      if (subtitleUrl) updateData.subtitle_url = subtitleUrl;
      if (dubbedAudioUrl) updateData.dubbed_audio_url = dubbedAudioUrl;

      await Episode.update(updateData, { where: { id: episodeId } });
      await notifyGateway('episode', episodeId, 'completed');
      logger.info(`[Transcoding Worker] Episode ${episodeId} transcoding completed successfully`);

    } catch (err) {
      logger.error(`[Transcoding Worker] Episode ${episodeId} transcoding failed`, { error: err.message });
      await Episode.update({ transcoding_status: 'failed' }, { where: { id: episodeId } });
      await notifyGateway('episode', episodeId, 'failed', { error: err.message });
      throw err;
    }
  }
}

function initTranscodingWorker(redisConnection) {
  const worker = new Worker('transcoding', async (job) => {
    const { name, data } = job;
    logger.info(`[Transcoding Worker] Starting job ${job.id}: ${name}`);
    return processTranscodingJob(name, data);
  }, {
    connection: redisConnection,
    concurrency: 1, // process one video transcode at a time to prevent CPU overload
  });

  worker.on('failed', (job, err) => {
    logger.error(`[Transcoding Worker] Job ${job.id} failed`, { error: err.message });
  });

  worker.on('error', (err) => {
    logger.error('[Transcoding Worker] BullMQ worker connection error:', { error: err.message });
  });

  return worker;
}

module.exports = { initTranscodingWorker, processTranscodingJob };
