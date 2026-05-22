/**
 * api/middleware/auth.js  [STUB — NOT ACTIVE]
 *
 * JWT authentication middleware.
 * Used by any route that requires a logged-in user.
 *
 * Usage (when implemented):
 *   const { requireAuth } = require('../middleware/auth');
 *   router.get('/protected', requireAuth, controller.handler);
 *
 * Behaviour:
 *   • Reads Bearer token from Authorization header
 *   • Verifies JWT signature against config.auth.jwtSecret
 *   • Attaches decoded user payload to req.user
 *   • Returns 401 if token missing or invalid
 *   • Returns 403 if token expired (client should refresh)
 */

'use strict';

// Stub — implementation deferred

// exports.requireAuth = (req, res, next) => {
//   const header = req.headers.authorization;
//   if (!header || !header.startsWith('Bearer ')) {
//     return res.status(401).json({ error: 'Authentication required' });
//   }
//   const token = header.slice(7);
//   try {
//     const payload = jwt.verify(token, config.auth.jwtSecret);
//     req.user = payload;
//     next();
//   } catch (err) {
//     const status = err.name === 'TokenExpiredError' ? 403 : 401;
//     res.status(status).json({ error: err.message });
//   }
// };
