import { Request, Response, NextFunction } from 'express';
import { RowDataPacket } from 'mysql2';
import { getPool } from '../utils/db';
import { getVeldnaamMap } from '../utils/veldnaam';

// In-memory rate-limiting cache for guest reset requests
const resetCooldowns = new Map<number, number>(); // pitchId -> timestamp of last reset
const RESET_COOLDOWN_MS = 60000; // 60 seconds

interface PitchStatusRow extends RowDataPacket {
  pltsnr: number;
  pltsnm: string;
  veldnr: number;
  stat: number;
  gewenst: number;
  kwhnu: number;
  kwhtot: number;
  iverb: number;
  imax: number;
  errorcode: number;
}

export async function getPitchStatus(
  req: Request<{ pltsnr: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { pltsnr } = req.params;
    const pitchId = parseInt(pltsnr, 10);

    if (isNaN(pitchId)) {
      res.status(400).json({ error: 'Invalid pitch number' });
      return;
    }

    const pool = getPool();
    console.time(`[guest] SELECT gegevens WHERE pltsnr=${pitchId}`);
    const [rows] = await pool.execute<PitchStatusRow[]>(
      'SELECT pltsnr, pltsnm, veldnr, stat, gewenst, kwhnu, kwhtot, iverb, imax, errorcode FROM gegevens WHERE pltsnr = ?',
      [pitchId]
    );
    console.timeEnd(`[guest] SELECT gegevens WHERE pltsnr=${pitchId}`);

    if (rows.length === 0) {
      res.status(404).json({ error: 'Pitch not found' });
      return;
    }

    const row = rows[0];
    const veldnaamMap = await getVeldnaamMap();
    res.json({
      pitchId: row.pltsnr,
      pitchName: row.pltsnm,
      veldNaam: veldnaamMap[row.veldnr] ?? '',
      stat: row.stat,
      gewenst: row.gewenst,
      kwhnu: row.kwhnu,
      kwhtot: row.kwhtot,
      iverb: row.iverb,
      maxAmperage: row.imax,
      errorcode: row.errorcode,
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPitchError(
  req: Request<{ pltsnr: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { pltsnr } = req.params;
    const pitchId = parseInt(pltsnr, 10);

    if (isNaN(pitchId)) {
      res.status(400).json({ error: 'Invalid pitch number' });
      return;
    }

    // Rate limiting check
    const lastReset = resetCooldowns.get(pitchId);
    const now = Date.now();
    if (lastReset && now - lastReset < RESET_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((RESET_COOLDOWN_MS - (now - lastReset)) / 1000);
      res.status(429).json({ error: `Please wait ${remainingSeconds} seconds before resetting again` });
      return;
    }

    const pool = getPool();

    // Step 1: Read current imax before resetting errorcode
    const [pitchRows] = await pool.execute<RowDataPacket[]>(
      'SELECT imax FROM gegevens WHERE pltsnr = ?',
      [pitchId]
    );
    const originalImax = pitchRows.length > 0 ? pitchRows[0].imax : null;

    // Step 2: Reset errorcode
    const [resetResult] = await pool.execute<RowDataPacket[]>(
      'UPDATE gegevens SET errorcode = 0 WHERE pltsnr = ?',
      [pitchId]
    );

    if ((resetResult as any).affectedRows === 0) {
      res.status(404).json({ error: 'Pitch not found' });
      return;
    }

    // Step 3: Wait for legacy PHP polling cycle, then re-write original imax
    await new Promise((resolve) => setTimeout(resolve, 3000));

    if (originalImax !== null) {
      await pool.execute(
        'UPDATE gegevens SET imax = ? WHERE pltsnr = ?',
        [originalImax, pitchId]
      );
    }

    // Record this reset in cooldown cache
    resetCooldowns.set(pitchId, now);

    // Clean up old entries periodically (every 100th call to prevent memory leak)
    if (resetCooldowns.size > 100) {
      const cutoff = now - RESET_COOLDOWN_MS;
      for (const [id, timestamp] of resetCooldowns.entries()) {
        if (timestamp < cutoff) {
          resetCooldowns.delete(id);
        }
      }
    }

    res.json({ success: true, pitchId });
  } catch (error) {
    next(error);
  }
}
