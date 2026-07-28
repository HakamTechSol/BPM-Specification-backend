import { Request, Response, NextFunction } from 'express';
import jwt, { type SignOptions } from 'jsonwebtoken';

interface LoginBody {
  username: string;
  password: string;
}

export async function login(
  req: Request<object, object, LoginBody>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const JWT_SECRET = process.env.JWT_SECRET || 'blueplug_jwt_secret_change_in_production_2026';
    const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || '8h') as SignOptions['expiresIn'];
    const { username, password } = req.body;

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

    const token = jwt.sign(
      { username, role: 'admin', iat: Math.floor(Date.now() / 1000) },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ token, username, role: 'admin' });
  } catch (error) {
    next(error);
  }
}
