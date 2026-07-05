const { Server } = require('socket.io');
const { verifyAccessToken } = require('../helpers/tokenHelper');
const UserRepository = require('../api/repositories/UserRepository');
const SubscriptionRepository = require('../api/repositories/SubscriptionRepository');
const logger = require('../config/logger');
const EVENTS = require('./events');

let io = null;

// ── Room helpers ─────────────────────────────────────────────────────────────

/** Private room for a single user */
const userRoom = (userId) => `user:${userId}`;

/** Private room for an affiliate's stats */
const affiliateRoom = (userId) => `affiliate:${userId}`;

/** Joined by all admins / team members */
const ADMIN_ROOM = 'admin';

/** Joined by everyone (broadcasts) */
const BROADCAST_ROOM = 'broadcast';

// ── Initialise ────────────────────────────────────────────────────────────────

function init(httpServer) {
  const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''));

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const normalizedOrigin = origin.replace(/\/$/, '');
        if (
          allowedOrigins.includes(normalizedOrigin) ||
          allowedOrigins.includes('*') ||
          process.env.NODE_ENV !== 'production'
        ) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'), false);
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  // ── Auth middleware ──────────────────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        socket.data.authenticated = false;
        return next(); // allow unauthenticated (read-only public events)
      }

      let decoded;
      try {
        decoded = verifyAccessToken(token);
      } catch {
        socket.data.authenticated = false;
        return next();
      }

      const user = await UserRepository.findById(decoded.id);
      if (!user || user.status === 'banned' || user.status === 'inactive') {
        socket.data.authenticated = false;
        return next();
      }

      socket.data.authenticated = true;
      socket.data.userId = user.id;
      socket.data.role = user.role?.name ?? 'subscriber';
      next();
    } catch (err) {
      logger.error('Socket auth error', { error: err.message });
      socket.data.authenticated = false;
      next();
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────
  io.on('connection', async (socket) => {
    const { authenticated, userId, role } = socket.data;

    // Everyone joins the broadcast room
    socket.join(BROADCAST_ROOM);

    if (authenticated) {
      // Per-user private room
      socket.join(userRoom(userId));

      // Affiliate room (every authenticated user can receive their own affiliate updates)
      socket.join(affiliateRoom(userId));

      // Admin room for privileged users
      if (role === 'super_admin' || role === 'team_member' || role === 'admin') {
        socket.join(ADMIN_ROOM);
      }

      logger.info('Socket connected', { userId, role, socketId: socket.id });

      // Check current connection count against plan's max screens
      try {
        const activeSub = await SubscriptionRepository.findActiveByUserId(userId);
        const maxScreens = activeSub && activeSub.plan ? activeSub.plan.max_screens : 2;

        const userSockets = Array.from(io.sockets.sockets.values()).filter(
          (s) => s.data.authenticated && s.data.userId === userId && s.id !== socket.id
        );
        const activeUnblockedSockets = userSockets.filter((s) => !s.data.isBlocked);

        if (activeUnblockedSockets.length >= maxScreens) {
          socket.data.isBlocked = true;
          socket.emit('max_screens_exceeded', {
            message: `your account is loggedin in ${maxScreens} screen please manage`,
            maxScreens,
          });
        } else {
          socket.data.isBlocked = false;
        }
      } catch (err) {
        logger.error('Socket connection limit check error', { error: err.message });
      }
    }

    socket.on('disconnect', async (reason) => {
      logger.info('Socket disconnected', { userId: userId ?? 'anon', reason });
      if (authenticated) {
        try {
          const activeSub = await SubscriptionRepository.findActiveByUserId(userId);
          const maxScreens = activeSub && activeSub.plan ? activeSub.plan.max_screens : 2;

          const userSockets = Array.from(io.sockets.sockets.values()).filter(
            (s) => s.data.authenticated && s.data.userId === userId
          );
          
          const unblocked = userSockets.filter((s) => !s.data.isBlocked);
          const blocked = userSockets.filter((s) => s.data.isBlocked);

          let unblockedCount = unblocked.length;
          while (unblockedCount < maxScreens && blocked.length > 0) {
            const nextSock = blocked.shift();
            if (nextSock) {
              nextSock.data.isBlocked = false;
              nextSock.emit('block_removed');
              unblockedCount++;
            }
          }
        } catch (err) {
          logger.error('Socket disconnect re-evaluation error', { error: err.message });
        }
      }
    });

    socket.on('error', (err) => {
      logger.error('Socket error', { error: err.message, userId });
    });
  });

  logger.info('Socket.IO server initialised');
  return io;
}

// ── Emit helpers (called from controllers / services) ────────────────────────

/** Emit to ALL connected clients */
function broadcast(event, payload) {
  if (!io) return;
  io.to(BROADCAST_ROOM).emit(event, payload);
}

/** Emit to a specific user */
function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to(userRoom(userId)).emit(event, payload);
}

/** Emit to all admins / team members */
function emitToAdmins(event, payload) {
  if (!io) return;
  io.to(ADMIN_ROOM).emit(event, payload);
}

/** Emit to a specific affiliate's stats room */
function emitToAffiliate(userId, event, payload) {
  if (!io) return;
  io.to(affiliateRoom(userId)).emit(event, payload);
}

/** Throttled dashboard stats push — debounced at 2 s to avoid spam */
let _statsTimer = null;
function pushDashboardStats(statsPayload) {
  if (!io) return;
  if (_statsTimer) clearTimeout(_statsTimer);
  _statsTimer = setTimeout(() => {
    io.to(ADMIN_ROOM).emit(EVENTS.DASHBOARD_STATS_UPDATED, statsPayload);
    _statsTimer = null;
  }, 2000);
}

function getIO() {
  return io;
}

module.exports = {
  init,
  getIO,
  broadcast,
  emitToUser,
  emitToAdmins,
  emitToAffiliate,
  pushDashboardStats,
  ROOMS: { ADMIN_ROOM, BROADCAST_ROOM, userRoom, affiliateRoom },
};
