const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  // Fail loudly rather than silently signing tokens with a guessable default —
  // a store's customer/admin auth should never run on a fallback secret.
  console.error('FATAL: JWT_SECRET is not set in your environment (.env file). Refusing to start.');
  process.exit(1);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, isAdmin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

/** Attaches req.user if a valid token is present; does NOT block the request otherwise. */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch (e) { /* invalid/expired token — proceed as a guest */ }
  }
  next();
}

/** Blocks the request unless a valid customer/admin token is present. */
function requireAuth(req, res, next) {
  optionalAuth(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
    next();
  });
}

/** Blocks the request unless the token belongs to an admin account. */
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    next();
  });
}

module.exports = { signToken, optionalAuth, requireAuth, requireAdmin, JWT_SECRET };
