import { Request, Response, NextFunction } from 'express';
import { RowDataPacket, ResultSetHeader } from 'mysql2';
import { getPool } from '../utils/db';
import { getVeldnaamMap } from '../utils/veldnaam';

interface StoringRow extends RowDataPacket {
  idstoring: number;
  PlaatsId: number;
  PlaatsNaam: string;
  StartStoring: string;
  StartTellerStand: number | null;
  EindStoring: string | null;
  EindTellerStand: number | null;
  StoringCode: number;
  Omschrijving: string | null;
  veldnr: number | null;
}

const SEVERITY_MAP: Record<number, string> = {
  2: 'critical',
  13: 'high',
  4: 'high',
  11: 'warning',
};

function deriveSeverity(code: number): 'critical' | 'high' | 'warning' {
  const raw = SEVERITY_MAP[code] ?? 'warning';
  if (raw === 'critical') return 'critical';
  if (raw === 'high') return 'high';
  return 'warning';
}

function mapRow(row: StoringRow, veldnaamMap: Record<number, string>) {
  return {
    id: row.idstoring,
    pitchId: row.PlaatsId,
    pitchName: row.PlaatsNaam,
    veldNaam: row.veldnr != null ? (veldnaamMap[row.veldnr] ?? '') : '',
    occurredAt: row.StartStoring,
    startMeterReading: row.StartTellerStand,
    resolvedAt: row.EindStoring,
    endMeterReading: row.EindTellerStand,
    failureCode: row.StoringCode,
    description: row.Omschrijving ?? '',
    severity: deriveSeverity(row.StoringCode),
  };
}

export async function getAllFailures(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  console.time('[failures] TOTAL getAllFailures');
  try {
    const pool = getPool();

    // Active failures (no limit — all need attention)
    console.time('[failures] SELECT active');
    const [activeRows] = await pool.execute<StoringRow[]>(
      `SELECT s.*, g.veldnr FROM storing s
       LEFT JOIN gegevens g ON s.PlaatsId = g.pltsnr
       WHERE s.EindStoring IS NULL ORDER BY s.StartStoring DESC`
    );
    console.timeEnd('[failures] SELECT active');

    // Recent resolved failures: last 30 days, max 50
    console.time('[failures] SELECT resolved (30d + LIMIT 50)');
    const [resolvedRows] = await pool.execute<StoringRow[]>(
      `SELECT s.*, g.veldnr FROM storing s
       LEFT JOIN gegevens g ON s.PlaatsId = g.pltsnr
       WHERE s.EindStoring IS NOT NULL AND s.EindStoring >= DATE_SUB(NOW(), INTERVAL 30 DAY)
       ORDER BY s.EindStoring DESC LIMIT 50`
    );
    console.timeEnd('[failures] SELECT resolved (30d + LIMIT 50)');

    // Total historical count (for context)
    console.time('[failures] SELECT COUNT(*)');
    const [countRows] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM storing'
    );
    console.timeEnd('[failures] SELECT COUNT(*)');
    const totalHistoricalCount = countRows[0]?.total ?? 0;

    const veldnaamMap = await getVeldnaamMap();

    const failures = [
      ...activeRows.map((r) => mapRow(r, veldnaamMap)),
      ...resolvedRows.map((r) => mapRow(r, veldnaamMap)),
    ];

    console.timeEnd('[failures] TOTAL getAllFailures');
    res.json({
      failures,
      activeCount: activeRows.length,
      recentResolvedCount: resolvedRows.length,
      totalHistoricalCount,
    });
  } catch (error) {
    console.timeEnd('[failures] TOTAL getAllFailures');
    next(error);
  }
}

export async function resolveFailure(
  req: Request<{ id: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid failure id' });
      return;
    }

    const pool = getPool();

    const [existing] = await pool.execute<StoringRow[]>(
      'SELECT idstoring, PlaatsId, EindStoring FROM storing WHERE idstoring = ?',
      [id]
    );

    if (existing.length === 0) {
      res.status(404).json({ error: 'Failure not found' });
      return;
    }

    if (existing[0].EindStoring !== null) {
      res.status(400).json({ error: 'Failure is already resolved' });
      return;
    }

    const plaatsId = existing[0].PlaatsId;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute<ResultSetHeader>(
        'UPDATE storing SET EindStoring = NOW() WHERE idstoring = ?',
        [id]
      );

      await conn.execute<ResultSetHeader>(
        'UPDATE gegevens SET errorcode = 0 WHERE pltsnr = ?',
        [plaatsId]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ success: true, pitchId: plaatsId });
  } catch (error) {
    next(error);
  }
}

export async function resolveAllFailures(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const pool = getPool();

    const [activeRows] = await pool.execute<StoringRow[]>(
      'SELECT DISTINCT PlaatsId FROM storing WHERE EindStoring IS NULL'
    );

    if (activeRows.length === 0) {
      res.json({ resolved: 0, pitchesAffected: [] });
      return;
    }

    const pitchIds = activeRows.map((r) => r.PlaatsId);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute<ResultSetHeader>(
        'UPDATE storing SET EindStoring = NOW() WHERE EindStoring IS NULL'
      );

      const placeholders = pitchIds.map(() => '?').join(',');
      await conn.execute<ResultSetHeader>(
        `UPDATE gegevens SET errorcode = 0 WHERE pltsnr IN (${placeholders})`,
        pitchIds
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ resolved: activeRows.length, pitchesAffected: pitchIds });
  } catch (error) {
    next(error);
  }
}
