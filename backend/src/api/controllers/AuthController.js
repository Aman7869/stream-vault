const AuthService = require("../services/AuthService");
const {
  successResponse,
  errorResponse,
} = require("../../helpers/responseHelper");
const MESSAGES = require("../../constants/messages");
const STATUS_CODES = require("../../constants/statusCodes");
const logger = require("../../config/logger");
const jwt = require("jsonwebtoken");
const { addNotificationJob } = require("../../queue");
const twilioConfig = require("../../config/twilio");
const UserRepository = require("../repositories/UserRepository");

class AuthController {
  async register(req, res) {
    try {
      const user = await AuthService.register(req.body);
      return successResponse(
        res,
        MESSAGES.REGISTER_SUCCESS,
        { user },
        STATUS_CODES.CREATED,
      );
    } catch (err) {
      logger.error("AuthController.register error", { error: err.message });
      if (err.statusCode === 409) {
        return errorResponse(
          res,
          MESSAGES.EMAIL_ALREADY_EXISTS,
          STATUS_CODES.CONFLICT,
        );
      }
      return errorResponse(
        res,
        err.message || MESSAGES.INTERNAL_ERROR,
        err.statusCode || STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async login(req, res) {
    try {
      console.log("--- AuthController.login request body ---", req.body);
      const { email, password, forceLogout } = req.body;
      const { user, accessToken, refreshToken } = await AuthService.login(
        email,
        password,
        !!forceLogout
      );

      // Log activity
      const { logActivity } = require('../../helpers/activityLogger');
      logActivity(user.id, 'user_login', { email: user.email }, req);

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return successResponse(res, MESSAGES.LOGIN_SUCCESS, {
        user,
        accessToken,
      });
    } catch (err) {
      logger.error("AuthController.login error", { error: err.message });
      if (err.code === 'MAX_SCREENS_EXCEEDED') {
        return res.status(STATUS_CODES.FORBIDDEN).json({
          success: false,
          message: err.message,
          code: 'MAX_SCREENS_EXCEEDED',
          maxScreens: err.maxScreens
        });
      }
      if (err.statusCode === 401) {
        return errorResponse(
          res,
          MESSAGES.INVALID_CREDENTIALS,
          STATUS_CODES.UNAUTHORIZED,
        );
      }
      if (err.statusCode === 403) {
        return errorResponse(res, err.message, STATUS_CODES.FORBIDDEN);
      }
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async logoutOthers(req, res) {
    try {
      const refresh_token = req.cookies?.refresh_token || req.body?.refresh_token;
      const { socketId } = req.body;
      await AuthService.logoutOthers(req.user.id, refresh_token, socketId);
      return successResponse(res, "Other screens logged out successfully");
    } catch (err) {
      logger.error("AuthController.logoutOthers error", { error: err.message });
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async refreshToken(req, res) {
    try {
      const refresh_token = req.cookies?.refresh_token || req.body?.refresh_token;
      const tokens = await AuthService.refreshToken(refresh_token);

      res.cookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return successResponse(res, MESSAGES.TOKEN_REFRESHED, {
        accessToken: tokens.accessToken,
      });
    } catch (err) {
      logger.error("AuthController.refreshToken error", { error: err.message });
      if (err.statusCode === 401) {
        return errorResponse(
          res,
          MESSAGES.INVALID_TOKEN,
          STATUS_CODES.UNAUTHORIZED,
        );
      }
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async logout(req, res) {
    try {
      const refresh_token = req.cookies?.refresh_token || req.body?.refresh_token;
      if (refresh_token) {
        await AuthService.logout(refresh_token);
      }
      res.clearCookie('refresh_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });
      return successResponse(res, MESSAGES.LOGOUT_SUCCESS);
    } catch (err) {
      logger.error("AuthController.logout error", { error: err.message });
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async forgotPassword(req, res) {
    try {
      const { email } = req.body;
      await AuthService.forgotPassword(email);
      // Always return success to avoid user enumeration
      return successResponse(res, MESSAGES.FORGOT_PASSWORD_SUCCESS);
    } catch (err) {
      logger.error("AuthController.forgotPassword error", {
        error: err.message,
      });
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async resetPassword(req, res) {
    try {
      const { token, password } = req.body;
      await AuthService.resetPassword(token, password);
      return successResponse(res, MESSAGES.RESET_PASSWORD_SUCCESS);
    } catch (err) {
      logger.error("AuthController.resetPassword error", {
        error: err.message,
      });
      if (err.statusCode === 400) {
        return errorResponse(
          res,
          MESSAGES.INVALID_RESET_TOKEN,
          STATUS_CODES.BAD_REQUEST,
        );
      }
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getProfile(req, res) {
    try {
      const user = await AuthService.getProfile(req.user.id);
      return successResponse(res, MESSAGES.PROFILE_FETCHED, { user });
    } catch (err) {
      logger.error("AuthController.getProfile error", { error: err.message });
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async updateProfile(req, res) {
    try {
      console.log("Content-Type:", req.headers["content-type"]); // ← check this
      console.log("req.body:", req.body);
      
      const user = await AuthService.updateProfile(req.user.id, req.body);
      return successResponse(res, MESSAGES.PROFILE_UPDATED, { user });
    } catch (err) {
      logger.error("AuthController.updateProfile error", {
        error: err.message,
      });
      if (err.statusCode) {
        return errorResponse(res, err.message, err.statusCode);
      }
      return errorResponse(
        res,
        MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async phoneSendOtp(req, res) {
    try {
      const { phone } = req.body;
      if (!phone) {
        return errorResponse(res, "Phone number is required", STATUS_CODES.BAD_REQUEST);
      }

      // Sanitize phone number (if 10 digits, prepend +91 for ease of use)
      let formattedPhone = phone.trim();
      if (/^\d{10}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
      }

      // Generate a 6-digit OTP code
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      
      // Store in global cache with 5 minute expiration
      if (!global.otpCache) {
        global.otpCache = new Map();
      }
      global.otpCache.set(formattedPhone, {
        otp,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });

      logger.info(`Generated OTP for ${formattedPhone}: ${otp}`);

      // Try sending via Twilio directly for instant delivery
      if (twilioConfig.isEnabled) {
        try {
          // Send SMS asynchronously in the background so HTTP response is instant,
          // but trigger Twilio request immediately without Redis/Queue queueing delays.
          twilioConfig.client.messages.create({
            body: `Your StreamVault verification code is ${otp}. Expires in 5 minutes.`,
            from: twilioConfig.phoneNumber,
            to: formattedPhone,
          }).then(message => {
            logger.info(`OTP SMS sent successfully via Twilio directly to ${formattedPhone}`, { messageId: message.sid });
          }).catch(err => {
            logger.error(`Failed to send OTP SMS via Twilio directly to ${formattedPhone}`, { error: err.message });
          });
          
          logger.info(`OTP SMS request dispatched directly to Twilio for ${formattedPhone}`);
        } catch (smsErr) {
          logger.error("Failed to dispatch OTP SMS to Twilio directly", { error: smsErr.message });
          // In development/fallback mode, allow proceeding
          if (process.env.NODE_ENV === "development") {
            console.log(`[DEVELOPMENT OTP FALLBACK] Code for ${formattedPhone}: ${otp}`);
            return successResponse(res, "OTP generated (Direct dispatch failed, dev mode fallback)", {
              devMode: true,
              otp,
            });
          } else {
            throw smsErr;
          }
        }
      } else {
        console.log(`[OTP CONSOLE LOG] Code for ${formattedPhone}: ${otp}`);
        return successResponse(res, "OTP generated (Console Log)", {
          devMode: true,
          otp,
        });
      }

      return successResponse(res, "OTP sent successfully", {
        devMode: false,
      });
    } catch (err) {
      logger.error("AuthController.phoneSendOtp error", { error: err.message });
      return errorResponse(
        res,
        err.message || MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async phoneVerifyOtp(req, res) {
    try {
      const { phone, otp, forceLogout } = req.body;
      if (!phone || !otp) {
        return errorResponse(res, "Phone number and OTP code are required", STATUS_CODES.BAD_REQUEST);
      }

      // Sanitize phone number (if 10 digits, prepend +91 for ease of use)
      let formattedPhone = phone.trim();
      if (/^\d{10}$/.test(formattedPhone)) {
        formattedPhone = `+91${formattedPhone}`;
      }

      // Check OTP in memory cache
      if (!global.otpCache) {
        global.otpCache = new Map();
      }
      const entry = global.otpCache.get(formattedPhone);
      if (!entry) {
        return errorResponse(res, "No OTP code request found for this phone number", STATUS_CODES.BAD_REQUEST);
      }

      if (entry.otp !== otp) {
        return errorResponse(res, "Invalid OTP code", STATUS_CODES.BAD_REQUEST);
      }

      if (Date.now() > entry.expiresAt) {
        global.otpCache.delete(formattedPhone);
        return errorResponse(res, "OTP code has expired", STATUS_CODES.BAD_REQUEST);
      }

      // Clear OTP on success
      global.otpCache.delete(formattedPhone);

      // Check if user exists
      const user = await UserRepository.findByPhone(formattedPhone);
      if (user) {
        // Log in the user automatically
        const { user: loggedInUser, accessToken, refreshToken } = await AuthService.loginByPhone(
          formattedPhone,
          !!forceLogout
        );

        res.cookie('refresh_token', refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });

        return successResponse(res, "OTP verified and logged in successfully", {
          isNewUser: false,
          user: loggedInUser,
          accessToken,
        });
      } else {
        // Sign a signup token valid for 15 minutes to prevent spoofing
        const signupToken = jwt.sign(
          { phone: formattedPhone, temp: true },
          process.env.JWT_SECRET || "change-this-secret-in-production",
          { expiresIn: "15m" }
        );

        return successResponse(res, "OTP verified. Finish registering your account details.", {
          isNewUser: true,
          phone: formattedPhone,
          signupToken,
        });
      }
    } catch (err) {
      logger.error("AuthController.phoneVerifyOtp error", { error: err.message });
      if (err.code === 'MAX_SCREENS_EXCEEDED') {
        return res.status(STATUS_CODES.FORBIDDEN).json({
          success: false,
          message: err.message,
          code: 'MAX_SCREENS_EXCEEDED',
          maxScreens: err.maxScreens
        });
      }
      return errorResponse(
        res,
        err.message || MESSAGES.INTERNAL_ERROR,
        STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async phoneCompleteSignup(req, res) {
    try {
      const { signupToken, first_name, last_name, email, password, ref_code } = req.body;
      if (!signupToken || !first_name || !last_name || !email || !password) {
        return errorResponse(res, "All fields are required to complete setup", STATUS_CODES.BAD_REQUEST);
      }

      // Verify signupToken
      let payload;
      try {
        payload = jwt.verify(
          signupToken,
          process.env.JWT_SECRET || "change-this-secret-in-production"
        );
      } catch (tokenErr) {
        return errorResponse(res, "Registration token has expired or is invalid. Please request a new OTP.", STATUS_CODES.UNAUTHORIZED);
      }

      if (!payload.phone || !payload.temp) {
        return errorResponse(res, "Invalid registration token", STATUS_CODES.BAD_REQUEST);
      }

      // Create new user using existing AuthService register method
      const user = await AuthService.register({
        first_name,
        last_name,
        email,
        password,
        phone: payload.phone,
        ref_code,
      });

      // Automatically generate active session token pair (log them in)
      const { user: loggedInUser, accessToken, refreshToken } = await AuthService.loginByPhone(
        payload.phone,
        false
      );

      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      return successResponse(
        res,
        "Account created and logged in successfully",
        {
          user: loggedInUser,
          accessToken,
        },
        STATUS_CODES.CREATED
      );
    } catch (err) {
      logger.error("AuthController.phoneCompleteSignup error", { error: err.message });
      if (err.statusCode === 409) {
        return errorResponse(
          res,
          MESSAGES.EMAIL_ALREADY_EXISTS,
          STATUS_CODES.CONFLICT,
        );
      }
      return errorResponse(
        res,
        err.message || MESSAGES.INTERNAL_ERROR,
        err.statusCode || STATUS_CODES.INTERNAL_SERVER_ERROR,
      );
    }
  }
}

module.exports = new AuthController();
