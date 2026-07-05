require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { generalLimiter } = require('./api/middlewares/rateLimiter');
const apiRoutes = require('./api/routes/index');
const logger = require('./config/logger');
const VideoTokenService = require('./api/services/VideoTokenService');

const app = express();

// ── Trust proxy — required when running behind Nginx/load balancer ────────────
// Without this, req.ip resolves to the proxy IP and all users share one rate limit counter.
app.set('trust proxy', 1);

// ── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim().replace(/\/$/, ''));

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    const normalizedOrigin = origin.replace(/\/$/, '');
    
    if (
      allowedOrigins.includes(normalizedOrigin) ||
      allowedOrigins.includes('*') ||
      normalizedOrigin.endsWith('.onrender.com') ||
      process.env.NODE_ENV !== 'production'
    ) {
      return callback(null, true);
    }
    
    return callback(new Error(`CORS policy does not allow origin: ${origin}`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'],
  credentials: true,
}));

// ── Stripe Webhook — MUST be before express.json() ───────────────────────────
// Raw body is required for Stripe signature verification
app.use('/api/v1/stripe/webhook', express.raw({ type: 'application/json' }));

// ── Body Parsers ──────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static Files ──────────────────────────────────────────────────────────────
// Thumbnails: public, long-cached
app.use('/uploads/thumbnails', express.static(path.join(__dirname, '../uploads/thumbnails'), {
  maxAge: '1d',
}));

// HLS segments & playlists: served statically for local-transcoded videos
app.use('/uploads/hls', (req, res, next) => {
  if (req.path.endsWith('.m3u8') || req.path.endsWith('key.key')) {
    // Allow public display videos on landing page to bypass token verification
    const requestParts = req.path.split('/');
    const videoId = requestParts[1];
    const allowedPublicVideos = (process.env.ALLOWED_PUBLIC_VIDEOS || 'video-46060afa-5de8-4053-ba36-5c11fbdba7a0,video-6b288930-5418-41e6-87e5-4ab73f76c6a8')
      .split(',')
      .map(id => id.trim());

    if (allowedPublicVideos.includes(videoId)) {
      return next();
    }

    const { token } = req.query;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Stream token required' });
    }
    const payload = VideoTokenService.verify(token);
    if (!payload) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Invalid or expired token' });
    }

        // Verify that the token filename matches the requested HLS directory
    const tokenParts = payload.filename.split('/');
    if (tokenParts[3] !== requestParts[1]) {
      return res.status(403).json({ success: false, message: 'Forbidden: Token mismatch' });
    }

    // Dynamically rewrite playlist files to propagate the token to sub-requests
    if (req.path.endsWith('.m3u8')) {
      const filePath = path.join(__dirname, '../uploads/hls', req.path);
      if (fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        if (req.path.endsWith('master.m3u8')) {
          // Append the token to the variant playlists
          content = content.replace(/playlist\.m3u8/g, `playlist.m3u8?token=${token}`);
        } else {
          // Append the token to the key.key URI in variant playlists
          content = content.replace(/URI="key\.key"/g, `URI="key.key?token=${token}"`);
        }
        
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(content);
      }
    }
  }
  next();
}, express.static(path.join(__dirname, '../uploads/hls'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    } else if (filePath.endsWith('.ts')) {
      res.setHeader('Content-Type', 'video/mp2t');
    } else if (filePath.endsWith('key.key')) {
      res.setHeader('Content-Type', 'application/octet-stream');
    }
  },
}));

// Subtitles: served statically with VTT mime-type
app.use('/uploads/subtitles', express.static(path.join(__dirname, '../uploads/subtitles'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.vtt')) {
      res.setHeader('Content-Type', 'text/vtt');
    } else if (filePath.endsWith('.srt')) {
      res.setHeader('Content-Type', 'text/plain');
    }
  },
}));

// Dubbed audio: served statically
app.use('/uploads/audio', express.static(path.join(__dirname, '../uploads/audio'), {
  maxAge: '1d',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp3')) {
      res.setHeader('Content-Type', 'audio/mpeg');
    }
  },
}));

// ── General Rate Limiter ──────────────────────────────────────────────────────
app.use('/api', generalLimiter);
app.get('/api/demo', (req, res) => {
  res.send('Hello World!!!');
});
// ── Request Logging ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/v1', apiRoutes);

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to StreamVault API',
    docs: '/api/v1/health',
    version: '1.0.0',
  });
});

// ── Debug Whisper ─────────────────────────────────────────────────────────────
app.get('/debug-whisper', (req, res) => {
  const { exec } = require('child_process');
  const cmd = req.query.cmd || 'echo "no cmd"';
  exec(cmd, (err, stdout, stderr) => {
    res.json({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      error: err ? err.message : null
    });
  });
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
  });

  // CORS error
  if (err.message && err.message.startsWith('CORS policy')) {
    return res.status(403).json({ success: false, message: err.message });
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'An internal server error occurred.'
    : err.message || 'An internal server error occurred.';

  res.status(statusCode).json({ success: false, message });
});

module.exports = app;
