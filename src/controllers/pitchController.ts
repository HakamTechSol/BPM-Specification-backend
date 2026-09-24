import { Request, Response, NextFunction } from 'express';
import { exec } from 'child_process';
import { RowDataPacket } from 'mysql2';
import { getPool } from '../utils/db';
import { decryptPitchId } from '../utils/cryptoHelper';
import { getVeldnaamMap } from '../utils/veldnaam';

interface TriggerSyncBody {
  pitchId: number;
  action: 'toggle_power' | 'set_amperage' | 'set_power_state' | 'set_free_usage' | 'set_afstandbesturing';
  value?: number;
}

interface PitchRow extends RowDataPacket {
  pltsnr: number;
  pltsnm: string;
  gewenst: number;
  afstandbesturing: number | null;
}

const VALID_ACTIONS = ['toggle_power', 'set_amperage', 'set_power_state', 'set_free_usage', 'set_afstandbesturing'];

export async function triggerSyncCommand(
  req: Request<object, object, TriggerSyncBody>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { pitchId, action, value } = req.body;

    if (!pitchId || !action) {
      res.status(400).json({ error: 'pitchId and action are required' });
      return;
    }

    if (!VALID_ACTIONS.includes(action)) {
      res.status(400).json({
        error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`,
      });
      return;
    }

    if ((action === 'set_amperage' || action === 'set_power_state' || action === 'set_free_usage') && value === undefined) {
      res.status(400).json({ error: `value is required for action: ${action}` });
      return;
    }

    const pool = getPool();
    let targetValue: number;
    let pitchRow: PitchRow | null = null;

    // ── Remote-control guard (server-enforced) ────────────────────────────
    // Local power control (toggle_power / set_power_state) and local settings
    // (set_amperage / set_free_usage) are disabled while a pitch is under
    // remote/cloud control: afstandbesturing > 0 means "Afstand" (1) or
    // "Afstand aan" (3), 0 (or NULL) means "Lokaal". This must be enforced
    // here in the backend — a frontend-only disable can be bypassed by any
    // direct API call (curl, Postman, scripts, etc.).
    if (
      action === 'toggle_power' ||
      action === 'set_power_state' ||
      action === 'set_amperage' ||
      action === 'set_free_usage'
    ) {
      const [rows] = await pool.execute<PitchRow[]>(
        'SELECT pltsnr, gewenst, afstandbesturing FROM gegevens WHERE pltsnr = ?',
        [pitchId]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'Pitch not found' });
        return;
      }
      pitchRow = rows[0];
      if ((pitchRow.afstandbesturing ?? 0) > 0) {
        res.status(403).json({ error: 'Pitch is under remote control — local control disabled' });
        return;
      }
    }

    switch (action) {
      case 'toggle_power': {
        if (!pitchRow) {
          res.status(500).json({ error: 'Pitch state not loaded' });
          return;
        }
        targetValue = pitchRow.gewenst === 1 ? 0 : 1;
        await pool.execute<RowDataPacket[]>(
          'UPDATE gegevens SET gewenst = ? WHERE pltsnr = ?',
          [targetValue, pitchId]
        );
        break;
      }

      case 'set_amperage':
        if (typeof value === 'number' && value >= 0 && value <= 255) {
          targetValue = value;
          await pool.execute<RowDataPacket[]>(
            'UPDATE gegevens SET imax = ? WHERE pltsnr = ?',
            [targetValue, pitchId]
          );
        } else {
          res.status(400).json({ error: 'value must be a number between 0 and 255' });
          return;
        }
        break;

      case 'set_power_state':
        if (value === 0 || value === 1) {
          targetValue = value;
          await pool.execute<RowDataPacket[]>(
            'UPDATE gegevens SET gewenst = ? WHERE pltsnr = ?',
            [targetValue, pitchId]
          );
        } else {
          res.status(400).json({ error: 'value must be 0 (off) or 1 (on)' });
          return;
        }
        break;

      case 'set_free_usage':
        if (typeof value === 'number' && value >= 0 && value <= 255) {
          targetValue = value;
          await pool.execute<RowDataPacket[]>(
            'UPDATE gegevens SET kwhvrij = ? WHERE pltsnr = ?',
            [targetValue, pitchId]
          );
        } else {
          res.status(400).json({ error: 'value must be a number between 0 and 255' });
          return;
        }
        break;

      case 'set_afstandbesturing':
        if (typeof value === 'number' && [0, 1, 3].includes(value)) {
          targetValue = value;
          await pool.execute<RowDataPacket[]>(
            'UPDATE gegevens SET afstandbesturing = ? WHERE pltsnr = ?',
            [targetValue, pitchId]
          );
        } else {
          res.status(400).json({ error: 'value must be 0 (Lokaal), 1 (Afstand), or 3 (Afstand aan)' });
          return;
        }
        break;
    }

    // Step 1: Send hardware trigger to EIB gateway (127.0.0.1:9019)
    // This matches the legacy zendEIBaktoren() pattern
    const hardwareBody = `Plts:${pitchId}  -`;
    fetch('http://127.0.0.1:9019', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: hardwareBody,
      signal: AbortSignal.timeout(2000), // 2 second timeout for local call
    }).catch((err) => {
      console.error(`Hardware trigger failed for pitch ${pitchId}:`, err.message);
    });

    // Step 2: Call PHP sync script to update stat in database
    const scriptPath = process.env.PHP_SCRIPT_PATH || '/var/www/html/apiTestUpdate.php';
    const command = `php ${scriptPath} ${pitchId} ${targetValue} > /dev/null 2>&1 &`;

    exec(command, (error) => {
      if (error) {
        console.error(`PHP sync script failed for pitch ${pitchId}: ${error.message}`);
      }
    });

    res.json({ success: true, pitchId, action });
  } catch (error) {
    next(error);
  }
}

interface PitchListRow extends RowDataPacket {
  pltsnr: number;
  pltsnm: string;
  veldnr: number;
  stat: number;
  gewenst: number;
  kwhnu: number;
  kwhtot: number;
  iverb: number;
  imax: number;
  kwhvrij: number;
  errorcode: number;
  gastnaam: string | null;
  afstandbesturing: number;
}

interface StoringRow extends RowDataPacket {
  idstoring: number;
  PlaatsId: number;
}

interface ReservationRow extends RowDataPacket {
  PlaatsNummer: string;
  CheckIn: string;
  ReserveringNummer: string | null;
  usage_limit: number | null;
  e_start: number | null;
}

const ERRORCODE_TO_STORING: Record<number, { storingCode: number; description: string }> = {
  1: { storingCode: 13, description: 'Automatisch gedetecteerd: meter niet beschikbaar' },
  2: { storingCode: 2,  description: 'Automatisch gedetecteerd: actor reageert niet' },
  4: { storingCode: 4,  description: 'Automatisch gedetecteerd: verzoek != werkelijke staat' },
};

export async function getAllPitches(
  _req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  console.time('[pitch] TOTAL getAllPitches');
  try {
    const pool = getPool();

    console.time('[pitch] SELECT gegevens');
    const [rows] = await pool.execute<PitchListRow[]>(
      'SELECT pltsnr, pltsnm, veldnr, stat, gewenst, kwhnu, COALESCE(NULLIF(kWhtotaal, 0), kwhtot) AS kwhtot, iverb, imax, kwhvrij, errorcode, gastnaam, afstandbesturing FROM gegevens WHERE pltsnr < 1000 ORDER BY pltsnr ASC'
    );
    console.timeEnd('[pitch] SELECT gegevens');

    const veldnaamMap = await getVeldnaamMap();

    const pitches = rows.map((row) => ({
      pitchId: row.pltsnr,
      pitchName: row.pltsnm,
      veldNaam: veldnaamMap[row.veldnr] ?? '',
      stat: row.stat,
      gewenst: row.gewenst,
      kwhnu: row.kwhnu,
      kwhtot: row.kwhtot,
      iverb: row.iverb,
      maxAmperage: row.imax,
      freeUsage: row.kwhvrij,
      errorcode: row.errorcode,
      guestName: row.gastnaam,
      afstandbesturing: row.afstandbesturing,
      reservation: null as { checkIn: string; reserveringNummer: string | null; usageLimit: number | null; eStart: number | null } | null,
    }));

    // Fetch active reservations for all pitches in one query (non-critical:
    // a failure here must not take down the whole pitch list)
    if (pitches.length > 0) {
      try {
        // reservering.PlaatsNummer stores the pitch NUMBER (gegevens.pltsnr),
        // not the pitch name (gegevens.pltsnm). Joined on pltsnr as a string.
        const pitchIds = pitches.map((p) => String(p.pitchId));
        const idPlaceholders = pitchIds.map(() => '?').join(',');
        console.time('[pitch] SELECT active reservations');
        const [resRows] = await pool.execute<ReservationRow[]>(
          `SELECT PlaatsNummer, CheckIn, ReserveringNummer, usage_limit, e_start
           FROM reservering
           WHERE CheckOut IS NULL AND PlaatsNummer IN (${idPlaceholders})
           ORDER BY CheckIn DESC`,
          pitchIds
        );
        console.timeEnd('[pitch] SELECT active reservations');

        // Map: take first (most recent) reservation per pitch id
        const resMap = new Map<string, ReservationRow>();
        for (const r of resRows) {
          if (!resMap.has(r.PlaatsNummer)) resMap.set(r.PlaatsNummer, r);
        }
        for (const p of pitches) {
          const r = resMap.get(String(p.pitchId));
          if (r) {
            p.reservation = {
              checkIn: r.CheckIn,
              reserveringNummer: r.ReserveringNummer,
              usageLimit: r.usage_limit,
              eStart: r.e_start,
            };
          }
        }
      } catch (err) {
        console.error('[pitch] Failed to load reservations:', err);
      }
    }

    // Failure detection: check for errorcode != 0 and insert into storing if no active failure exists
    // (non-critical: a failure here must not take down the whole pitch list)
    try {
      const errorPitches = rows.filter((row) => row.errorcode !== 0);
      if (errorPitches.length > 0) {
        const errorIds = errorPitches.map((r) => r.pltsnr);
        const placeholders = errorIds.map(() => '?').join(',');

        console.time('[pitch] SELECT storing (active failures check)');
        const [existingFailures] = await pool.execute<StoringRow[]>(
          `SELECT PlaatsId FROM storing WHERE PlaatsId IN (${placeholders}) AND EindStoring IS NULL`,
          errorIds
        );
        console.timeEnd('[pitch] SELECT storing (active failures check)');
        const existingSet = new Set(existingFailures.map((r) => r.PlaatsId));

        let insertCount = 0;
        for (const row of errorPitches) {
          if (existingSet.has(row.pltsnr)) continue;

          const mapping = ERRORCODE_TO_STORING[row.errorcode] ?? {
            storingCode: row.errorcode,
            description: `Automatisch gedetecteerd: errorcode ${row.errorcode}`,
          };

          console.time(`[pitch] INSERT storing (pitch ${row.pltsnr})`);
          await pool.execute(
            'INSERT INTO storing (PlaatsId, PlaatsNaam, StartStoring, StoringCode, Omschrijving) VALUES (?, ?, NOW(), ?, ?)',
            [row.pltsnr, row.pltsnm, mapping.storingCode, mapping.description]
          );
          console.timeEnd(`[pitch] INSERT storing (pitch ${row.pltsnr})`);
          insertCount++;
        }
        if (insertCount > 0) {
          console.log(`[pitch] Inserted ${insertCount} new failure records`);
        }
      }
    } catch (err) {
      console.error('[pitch] Failure detection INSERT failed:', err);
    }

    console.timeEnd('[pitch] TOTAL getAllPitches');
    res.json({ pitches });
  } catch (error) {
    console.timeEnd('[pitch] TOTAL getAllPitches');
    next(error);
  }
}

export async function resolveHash(
  req: Request<{ hash: string }>,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { hash } = req.params;

    if (!hash) {
      res.status(400).json({ error: 'Hash parameter is required' });
      return;
    }

    let pitchId: number;
    try {
      pitchId = decryptPitchId(hash);
    } catch {
      res.status(400).json({ error: 'Invalid or malformed token' });
      return;
    }

    const pool = getPool();
    const [rows] = await pool.execute<PitchRow[]>(
      'SELECT pltsnr, pltsnm FROM gegevens WHERE pltsnr = ?',
      [pitchId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: 'Pitch not found' });
      return;
    }

    res.json({
      pitchId: rows[0].pltsnr,
      pitchName: rows[0].pltsnm,
    });
  } catch (error) {
    next(error);
  }
}
