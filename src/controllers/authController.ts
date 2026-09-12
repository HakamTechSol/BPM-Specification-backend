import { Request, Response, NextFunction } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { getPool } from '../utils/db';
import { type RowDataPacket } from 'mysql2';

interface LoginBody {
  username: string;
  password: string;
  remember?: boolean;
}

export async function login(
  req: Request<object, object, LoginBody>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'blueplug_jwt_secret_change_in_production_2026';
    const DEFAULT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '8h') as SignOptions['expiresIn'];
    const { username, password, remember } = req.body;

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }

    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || '';

    if (username !== adminUser || password !== adminPass) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }

    let expiresIn: SignOptions['expiresIn'] = DEFAULT_EXPIRES_IN;

    if (remember) {
      try {
        const pool = getPool();
        const [rows] = await pool.execute<RowDataPacket[]>(
          'SELECT session_duration_days FROM instellingen WHERE idinstellingen = 0'
        );
        const days = rows.length > 0 ? Number(rows[0]?.session_duration_days) : NaN;
        if (Number.isFinite(days) && days > 0) {
          expiresIn = `${days}d` as unknown as SignOptions['expiresIn'];
        } else {
          // Missing/NULL value (e.g. settings never saved): fall back to the
          // same default the settings endpoint reports, never a silent short token.
          expiresIn = '30d';
          console.warn('[auth] session_duration_days missing in instellingen, falling back to 30d');
        }
      } catch (err) {
        expiresIn = '30d';
        console.error('[auth] Failed reading session_duration_days, falling back to 30d:', err);
      }
    }

    const token = jwt.sign(
      { username, role: 'admin', iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn }
    );

    res.json({ token, username, role: 'admin' });
  } catch (error) {
    next(error);
  }
}
