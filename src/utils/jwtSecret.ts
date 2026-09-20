// ─── JWT signing/verification secret ────────────────────────────────────────
//
// The secret must be IDENTICAL in every process that issues or verifies
// tokens. If it ever differs between restarts, every stored session (including
// the 30-day "remember me" tokens) is invalidated instantly, even though the
// tokens' `exp` is still far in the future — the login page simply starts
// rejecting them ("Invalid or expired token") and the user is forced to log in
// again.
//
// Rules enforced here:
//  - The secret is read lazily at call time (never at module scope), because
//    backend/.env is loaded by dotenv.config() in app.ts and the import chain
//    runs before that statement.
//  - In production (anything that is not development/test) there is NO
//    fallback: if JWT_SECRET is missing the process must not serve tokens. The
//    secret is set ONCE, directly on the production server in backend/.env —
//    the deploy pipeline copies only dist/ and package files and must never
//    touch .env — so it stays identical across restarts and deployments.
//  - In development/test a fixed local default is allowed so `npm run dev`
//    keeps working out of the box.
//
// A hardcoded default in production was the root cause of sessions dying on
// restart: the effective secret silently depended on ambient server state
// (presence of .env, CWD of the pm2 process, exported vars), and any drift
// between the sign and verify processes invalidated all previously issued
// tokens.

const DEV_FALLBACK_JWT_SECRET = 'XfQvnlssGH7kS35BAl5LcFTgUjFpOXGv2T5MhQDfMLw';

export function getJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;

  const isDev =
    process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
  if (isDev) return DEV_FALLBACK_JWT_SECRET;

  throw new Error(
    'JWT_SECRET is not set. Set it once in the production server\'s backend/.env ' +
      '(the deploy pipeline copies only dist/ and package files, never .env). ' +
      'It must stay identical across restarts and deployments, otherwise all ' +
      'stored sessions are invalidated on every restart.'
  );
}