import { Request, Response, NextFunction } from 'express';
import { RowDataPacket } from 'mysql2';
import { getPool } from '../utils/db';

interface InstellingenRow extends RowDataPacket {
  idinstellingen: number;
  stroominstelling: string | null;
  vrijverbruikinstelling: string | null;
  stroomtarief: string | null;
  factuurinstelling: string | null;
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

export async function getSettings(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const pool = getPool();
    const [rows] = await pool.execute<InstellingenRow[]>(
      'SELECT idinstellingen, stroominstelling, vrijverbruikinstelling, eigenaar FROM instellingen WHERE idinstellingen = 0'
    );

    if (rows.length === 0) {
      // Return default settings if none exist
      res.json({
        id: 0,
        stroominstelling: ["6", "8", "10", "12", "16"],
        vrijverbruikinstelling: ["0", "1", "2", "4", "8"],
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
      eigenaar,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateSettings(
  req: Request<object, object, { eigenaar?: Partial<Eigenaar> }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { eigenaar } = req.body;

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

    if (existing.length === 0) {
      // Insert new settings row
      await pool.execute(
        'INSERT INTO instellingen (idinstellingen, eigenaar) VALUES (0, ?)',
        [JSON.stringify(updatedEigenaar)]
      );
    } else {
      // Update existing settings
      await pool.execute(
        'UPDATE instellingen SET eigenaar = ? WHERE idinstellingen = 0',
        [JSON.stringify(updatedEigenaar)]
      );
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
}
