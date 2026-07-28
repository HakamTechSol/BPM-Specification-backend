import { Request, Response, NextFunction } from 'express';

export function securityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const CSP_CONNECT_SRC = process.env.CSP_CONNECT_SRC || "'self' http://localhost:5173 http://localhost:3001";
  const BACKEND_SELF = process.env.CSP_BACKEND_SELF || "'self'";
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()'
  );

  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src ${BACKEND_SELF} ${CSP_CONNECT_SRC}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );

  next();
}
