const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const UserRepository = require('../repositories/UserRepository');
const SubscriptionRepository = require('../repositories/SubscriptionRepository');
const { RefreshToken, Role, AffiliateCode, ReferralConversion } = require('../../models');
const COMMISSION_RATE = parseFloat(process.env.AFFILIATE_COMMISSION_RATE || '0.10');
const socketServer = require('../../socket');
const EVENTS = require('../../socket/events');
const {
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenExpiry,
  generatePasswordResetToken,
  verifyPasswordResetToken,
} = require('../../helpers/tokenHelper');
const EmailService = require('./EmailService');
const logger = require('../../config/logger');
const ROLES = require('../../constants/roles');

class AuthService {
  /**
   * Register a new subscriber.
   */
  async register(data) {
    const { first_name, last_name, email, password, phone, ref_code } = data;

    // Check for existing email
    const existing = await UserRepository.findByEmail(email);
    if (existing) {
      const err = new Error('Email already exists');
      err.statusCode = 409;
      throw err;
    }

    // Find subscriber role
    const role = await Role.findOne({ where: { name: ROLES.SUBSCRIBER } });
    if (!role) throw new Error('Subscriber role not found. Please run seeders.');

    // Hash password
    const hashed = await bcrypt.hash(password, 12);

    const user = await UserRepository.create({
      role_id: role.id,
      first_name,
      last_name,
      email,
      password: hashed,
      phone: phone || null,
      email_verified: false,
      status: 'active',
    });

    // Send welcome email (non-blocking)
    EmailService.sendWelcomeEmail(user).catch((e) =>
      logger.warn('Welcome email failed', { userId: user.id, error: e.message })
    );

    // Process referral attribution (non-blocking, never fails the registration)
    if (ref_code) {
      (async () => {
        try {
          const affiliateCode = await AffiliateCode.findOne({ where: { code: ref_code } });
          if (affiliateCode && affiliateCode.user_id !== user.id) {
            await ReferralConversion.create({
              affiliate_code_id: affiliateCode.id,
              referred_user_id: user.id,
              commission_rate: COMMISSION_RATE,
              status: 'pending',
            });
            logger.info('Referral conversion created', { ref_code, referredUserId: user.id });

            // Notify the affiliate that a new referral signed up
            socketServer.emitToAffiliate(affiliateCode.user_id, EVENTS.AFFILIATE_REFERRAL_NEW, {
              referredUserId: user.id,
              status: 'pending',
            });
            socketServer.emitToAffiliate(affiliateCode.user_id, EVENTS.AFFILIATE_STATS_UPDATED, { refresh: true });
            socketServer.pushDashboardStats({ refresh: true });
          }
        } catch (e) {
          logger.warn('Referral tracking failed', { ref_code, error: e.message });
        }
      })();
    }

    const safeUser = await UserRepository.findById(user.id);
    return safeUser;
  }

  /**
   * Login any user.
   * Returns { user, accessToken, refreshToken }
   */
  async login(email, password, forceLogout = false) {
    const user = await UserRepository.findByEmailWithPassword(email);

    if (!user) {
      const err = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    if (user.status === 'inactive') {
      const err = new Error('Account is inactive');
      err.statusCode = 403;
      throw err;
    }
    if (user.status === 'banned') {
      const err = new Error('Account is banned');
      err.statusCode = 403;
      throw err;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      const err = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    // Retrieve subscription plan details to check session limit
    const activeSub = await SubscriptionRepository.findActiveByUserId(user.id);
    const maxScreens = activeSub && activeSub.plan ? activeSub.plan.max_screens : 2;

    if (forceLogout) {
      // Revoke all existing refresh tokens
      await RefreshToken.update(
        { is_revoked: true },
        { where: { user_id: user.id, is_revoked: false } }
      );

      // Disconnect all active socket connections
      const io = socketServer.getIO();
      if (io) {
        const userSockets = Array.from(io.sockets.sockets.values()).filter(
          (s) => s.data.userId === user.id
        );
        userSockets.forEach((s) => {
          s.emit('max_screens_exceeded', { message: 'force_logged_out' });
          s.disconnect(true);
        });
      }
    } else {
      // Check active refresh token count against subscription limit
      const activeSessions = await RefreshToken.count({
        where: {
          user_id: user.id,
          is_revoked: false,
          expires_at: { [Op.gt]: new Date() },
        },
      });

      if (activeSessions >= maxScreens) {
        const err = new Error(`your account is loggedin in ${maxScreens} screen please manage`);
        err.statusCode = 403;
        err.code = 'MAX_SCREENS_EXCEEDED';
        err.maxScreens = maxScreens;
        throw err;
      }
    }

    // Update last_login (non-blocking)
    UserRepository.updateById(user.id, { last_login: new Date() }).catch(() => {});

    const payload = { id: user.id, email: user.email, role: user.role?.name };
    const accessToken = generateAccessToken(payload);
    const refreshTokenValue = generateRefreshToken();
    const expiresAt = getRefreshTokenExpiry();

    await RefreshToken.create({
      user_id: user.id,
      token: refreshTokenValue,
      expires_at: expiresAt,
      is_revoked: false,
    });

    const safeUser = await UserRepository.findById(user.id);
    return { user: safeUser, accessToken, refreshToken: refreshTokenValue };
  }

  /**
   * Revoke all other refresh tokens for the user and disconnect their sockets.
   */
  async logoutOthers(userId, currentRefreshToken, keepSocketId) {
    const whereClause = {
      user_id: userId,
      is_revoked: false,
    };
    if (currentRefreshToken) {
      whereClause.token = { [Op.ne]: currentRefreshToken };
    }
    await RefreshToken.update(
      { is_revoked: true },
      { where: whereClause }
    );

    const io = socketServer.getIO();
    if (io) {
      const userSockets = Array.from(io.sockets.sockets.values()).filter(
        (s) => s.data.userId === userId && s.id !== keepSocketId
      );
      userSockets.forEach((s) => {
        s.emit('max_screens_exceeded', { message: 'force_logged_out' });
        s.disconnect(true);
      });
    }
  }

  /**
   * Rotate refresh token.
   * Returns { accessToken, refreshToken }
   */
  async refreshToken(oldToken) {
    const record = await RefreshToken.findOne({
      where: {
        token: oldToken,
        is_revoked: false,
        expires_at: { [Op.gt]: new Date() },
      },
    });

    if (!record) {
      const err = new Error('Invalid or expired refresh token');
      err.statusCode = 401;
      throw err;
    }

    // Revoke old token
    await record.update({ is_revoked: true });

    const user = await UserRepository.findById(record.user_id);
    if (!user || user.status !== 'active') {
      const err = new Error('User not found or inactive');
      err.statusCode = 401;
      throw err;
    }

    const payload = { id: user.id, email: user.email, role: user.role?.name };
    const accessToken = generateAccessToken(payload);
    const newRefreshToken = generateRefreshToken();
    const expiresAt = getRefreshTokenExpiry();

    await RefreshToken.create({
      user_id: user.id,
      token: newRefreshToken,
      expires_at: expiresAt,
      is_revoked: false,
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * Logout — revoke the refresh token.
   */
  async logout(refreshTokenValue) {
    await RefreshToken.update(
      { is_revoked: true },
      { where: { token: refreshTokenValue } }
    );
  }

  /**
   * Forgot password — generate reset token, store in user, send email.
   */
  async forgotPassword(email) {
    const user = await UserRepository.findByEmail(email);
    // Always return success (don't expose whether email exists)
    if (!user) return;

    const resetToken = generatePasswordResetToken({ id: user.id, email: user.email });
    const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await UserRepository.updateById(user.id, {
      reset_token: resetToken,
      reset_token_expiry: expiry,
    });

    EmailService.sendPasswordResetEmail(user, resetToken).catch((e) =>
      logger.warn('Reset email failed', { userId: user.id, error: e.message })
    );
  }

  /**
   * Reset password — verify token, update password.
   */
  async resetPassword(token, newPassword) {
    let decoded;
    try {
      decoded = verifyPasswordResetToken(token);
    } catch {
      const err = new Error('Invalid or expired reset token');
      err.statusCode = 400;
      throw err;
    }

    const user = await UserRepository.findByResetToken(token);
    if (!user || user.id !== decoded.id) {
      const err = new Error('Invalid or expired reset token');
      err.statusCode = 400;
      throw err;
    }

    const hashed = await bcrypt.hash(newPassword, 12);
    await UserRepository.updateById(user.id, {
      password: hashed,
      reset_token: null,
      reset_token_expiry: null,
    });

    // Revoke all refresh tokens for this user
    await RefreshToken.update({ is_revoked: true }, { where: { user_id: user.id } });
  }

  /**
   * Get profile.
   */
  async getProfile(userId) {
    return UserRepository.findById(userId);
  }

  /**
   * Update profile.
   */
  async updateProfile(userId, data) {
    console.log('data: ', data);
    console.log('userId: ', userId);

    const updateData = { ...data };

    // Hash password if a new password is provided
    if (data.password) {
      const user = await UserRepository.findByIdWithPassword(userId);
      if (!user) {
        const err = new Error('User not found');
        err.statusCode = 404;
        throw err;
      }

      // If user has a password, verify the current password first
      if (user.password) {
        if (!data.current_password) {
          const err = new Error('Current password is required to set a new password');
          err.statusCode = 400;
          throw err;
        }
        const isMatch = await bcrypt.compare(data.current_password, user.password);
        if (!isMatch) {
          const err = new Error('Incorrect current password');
          err.statusCode = 400;
          throw err;
        }
      }

      updateData.password = await bcrypt.hash(data.password, 12);
    } else {
      delete updateData.password;
    }

    // current_password is not a database column, so delete it before the repository update
    delete updateData.current_password;

    await UserRepository.updateById(userId, updateData);
    return UserRepository.findById(userId);
  }

  /**
   * Login by phone number (OTP already verified).
   * Returns { user, accessToken, refreshToken }
   */
  async loginByPhone(phone, forceLogout = false) {
    const user = await UserRepository.findByPhone(phone);

    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    if (user.status === 'inactive') {
      const err = new Error('Account is inactive');
      err.statusCode = 403;
      throw err;
    }
    if (user.status === 'banned') {
      const err = new Error('Account is banned');
      err.statusCode = 403;
      throw err;
    }

    // Retrieve subscription plan details to check session limit
    const activeSub = await SubscriptionRepository.findActiveByUserId(user.id);
    const maxScreens = activeSub && activeSub.plan ? activeSub.plan.max_screens : 2;

    if (forceLogout) {
      // Revoke all existing refresh tokens
      await RefreshToken.update(
        { is_revoked: true },
        { where: { user_id: user.id, is_revoked: false } }
      );

      // Disconnect all active socket connections
      const io = socketServer.getIO();
      if (io) {
        const userSockets = Array.from(io.sockets.sockets.values()).filter(
          (s) => s.data.userId === user.id
        );
        userSockets.forEach((s) => {
          s.emit('max_screens_exceeded', { message: 'force_logged_out' });
          s.disconnect(true);
        });
      }
    } else {
      // Check active refresh token count against subscription limit
      const activeSessions = await RefreshToken.count({
        where: {
          user_id: user.id,
          is_revoked: false,
          expires_at: { [Op.gt]: new Date() },
        },
      });

      if (activeSessions >= maxScreens) {
        const err = new Error(`your account is loggedin in ${maxScreens} screen please manage`);
        err.statusCode = 403;
        err.code = 'MAX_SCREENS_EXCEEDED';
        err.maxScreens = maxScreens;
        throw err;
      }
    }

    // Update last_login (non-blocking)
    UserRepository.updateById(user.id, { last_login: new Date() }).catch(() => {});

    const payload = { id: user.id, email: user.email, role: user.role?.name };
    const accessToken = generateAccessToken(payload);
    const refreshTokenValue = generateRefreshToken();
    const expiresAt = getRefreshTokenExpiry();

    await RefreshToken.create({
      user_id: user.id,
      token: refreshTokenValue,
      expires_at: expiresAt,
      is_revoked: false,
    });

    const safeUser = await UserRepository.findById(user.id);
    return { user: safeUser, accessToken, refreshToken: refreshTokenValue };
  }
}

module.exports = new AuthService();
