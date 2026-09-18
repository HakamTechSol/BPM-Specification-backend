import { Request, Response, NextFunction } from 'express';
import { RowDataPacket } from 'mysql2';
import { getPool } from '../utils/db';

interface InstellingenRow extends RowDataPacket {
  idinstellingen: number;
  stroominstelling: string | null;
  vrijverbruikinstelling: string | null;
  stroomtarief: string | null;
  factuurinstelling: string | null;
  session_duration_days: number | null;
  eigenaar: string | null;
}

interface Eigenaar {
  naam?: string;
  straat?: string;
  nummer?: string;
  postcode?: string;
  plaats?: string;
  land?: string;
  telefoon?: string;
  email?: string;
  website?: string;
  kvk?: string;
  'btw-nummer'?: string;
}

// System-wide options that admins may enable/disable from the settings page.
const STROOM_OPTIONS = ['6', '8', '10', '12', '16'];
const VRIJ_OPTIONS = ['0', '1', '2', '4', '8'];

// Keep only values from the allowed set, de-duplicated and in canonical order.
function normalizeOptionArray(value: unknown, allowed: string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  const selected = new Set(value.map((v) => String(v)));
  return allowed.filter((option) => selected.has(option));
}

export async function getSettings(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const pool = getPool();
    const [rows] = await pool.execute<InstellingenRow[]>(
      'SELECT idinstellingen, stroominstelling, vrijverbruikinstelling, session_duration_days, eigenaar FROM instellingen WHERE idinstellingen = 0'
    );

    if (rows.length === 0) {
      // Return default settings if none exist
      res.json({
        id: 0,
        stroominstelling: ["6", "8", "10", "12", "16"],
        vrijverbruikinstelling: ["0", "1", "2", "4", "8"],
        sessionDurationDays: 30,
        eigenaar: {},
      });
      return;
    }

    const row = rows[0];
    
    // Parse JSON fields
    let stroominstelling: string[] = [];
    let vrijverbruikinstelling: string[] = [];
    let eigenaar: Eigenaar = {};

    try {
      stroominstelling = row.stroominstelling ? JSON.parse(row.stroominstelling) : ["6", "8", "10", "12", "16"];
    } catch {
      stroominstelling = ["6", "8", "10", "12", "16"];
    }

    try {
      vrijverbruikinstelling = row.vrijverbruikinstelling ? JSON.parse(row.vrijverbruikinstelling) : ["0", "1", "2", "4", "8"];
    } catch {
      vrijverbruikinstelling = ["0", "1", "2", "4", "8"];
    }

    try {
      eigenaar = row.eigenaar ? JSON.parse(row.eigenaar) : {};
    } catch {
      eigenaar = {};
    }

    res.json({
      id: row.idinstellingen,
      stroominstelling,
      vrijverbruikinstelling,
      sessionDurationDays: row.session_duration_days ?? 30,
      eigenaar,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateSettings(
  req: Request<
    object,
    object,
    {
      eigenaar?: Partial<Eigenaar>;
      sessionDurationDays?: number;
      stroominstelling?: string[];
      vrijverbruikinstelling?: string[];
    }
  >,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { eigenaar, sessionDurationDays, stroominstelling, vrijverbruikinstelling } = req.body;

    const pool = getPool();

    // Check if settings row exists
    const [existing] = await pool.execute<RowDataPacket[]>(
      'SELECT idinstellingen, eigenaar FROM instellingen WHERE idinstellingen = 0'
    );

    let currentEigenaar: Eigenaar = {};
    if (existing.length > 0) {
      const row = existing[0] as { eigenaar: string | null };
      try {
        currentEigenaar = row.eigenaar ? JSON.parse(row.eigenaar) : {};
      } catch {
        currentEigenaar = {};
      }
    }

    // Merge provided eigenaar fields with existing
    const updatedEigenaar = { ...currentEigenaar, ...eigenaar };

    // Validate session_duration_days (1-365, 1 decimal)
    let validDuration: number | null = null;
    if (sessionDurationDays !== undefined) {
      const d = Math.round(sessionDurationDays * 10) / 10;
      validDuration = Math.max(1, Math.min(365, d));
    }

    // Validate option arrays: only known options, de-duplicated, canonical order.
    // `null` means the field was not provided and should stay untouched.
    const normalizedStroom = normalizeOptionArray(stroominstelling, STROOM_OPTIONS);
    const normalizedVrij = normalizeOptionArray(vrijverbruikinstelling, VRIJ_OPTIONS);

    if (existing.length === 0) {
      const columns = ['idinstellingen', 'eigenaar'];
      const values: (string | number)[] = [0, JSON.stringify(updatedEigenaar)];
      if (validDuration !== null) {
        columns.push('session_duration_days');
        values.push(validDuration);
      }
      if (normalizedStroom !== null) {
        columns.push('stroominstelling');
        values.push(JSON.stringify(normalizedStroom));
      }
      if (normalizedVrij !== null) {
        columns.push('vrijverbruikinstelling');
        values.push(JSON.stringify(normalizedVrij));
      }
      await pool.execute(
        `INSERT INTO instellingen (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        values
      );
    } else {
      const sets = ['eigenaar = ?'];
      const values: (string | number)[] = [JSON.stringify(updatedEigenaar)];
      if (validDuration !== null) {
        sets.push('session_duration_days = ?');
        values.push(validDuration);
      }
      if (normalizedStroom !== null) {
        sets.push('stroominstelling = ?');
        values.push(JSON.stringify(normalizedStroom));
      }
      if (normalizedVrij !== null) {
        sets.push('vrijverbruikinstelling = ?');
        values.push(JSON.stringify(normalizedVrij));
      }
      values.push(0);
      await pool.execute(
        `UPDATE instellingen SET ${sets.join(', ')} WHERE idinstellingen = ?`,
        values
      );
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
