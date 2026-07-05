const express = require('express');
const router = express.Router();
const AuthController = require('../controllers/AuthController');
const authenticate = require('../middlewares/authenticate');
const { authLimiter } = require('../middlewares/rateLimiter');
const {
  validateRegister,
  validateLogin,
  validateRefreshToken,
  validateForgotPassword,
  validateResetPassword,
  validateUpdateProfile,
} = require('../validators/auth.validator');

console.log('Auth routes initialized');
// Public routes (with auth rate limiting)
router.post('/register', authLimiter, validateRegister, AuthController.register.bind(AuthController));
router.post('/login', authLimiter, validateLogin, AuthController.login.bind(AuthController));
router.post('/refresh-token', validateRefreshToken, AuthController.refreshToken.bind(AuthController));
router.post('/logout', validateRefreshToken, AuthController.logout.bind(AuthController));
router.post('/forgot-password', authLimiter, validateForgotPassword, AuthController.forgotPassword.bind(AuthController));
router.post('/reset-password', validateResetPassword, AuthController.resetPassword.bind(AuthController));
router.post('/phone/send-otp', authLimiter, AuthController.phoneSendOtp.bind(AuthController));
router.post('/phone/verify-otp', authLimiter, AuthController.phoneVerifyOtp.bind(AuthController));
router.post('/phone/complete-signup', authLimiter, AuthController.phoneCompleteSignup.bind(AuthController));
if (process.env.NODE_ENV === 'development') {
  router.get('/phone/get-otp-debug/:phone', (req, res) => {
    const entry = global.otpCache?.get(req.params.phone);
    res.json({ otp: entry ? entry.otp : null });
  });
}

// Protected routes
router.get('/profile', authenticate, AuthController.getProfile.bind(AuthController));
router.put('/profile', authenticate, validateUpdateProfile, AuthController.updateProfile.bind(AuthController));
router.post('/logout-others', authenticate, AuthController.logoutOthers.bind(AuthController));

module.exports = router;
