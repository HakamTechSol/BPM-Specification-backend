/**
 * Free usage ("gratis verbruik"), replicating the legacy PHP exactly.
 *
 * The `gegevens` table stores the free allowance in PULSES, not in kWh:
 *
 *   WRITE (legacy veld.php / setPlaatsGegevensForm):
 *     newKwhvrij  = kwhvrijopname * kwhpulsen              // kWh -> pulses
 *     if (newKwhvrij <> kwhvrijprev) {
 *         setGegeven('kwhvrijprev',          newKwhvrij);
 *         setGegeven('nextvrijaftrekcheck',  midnight1);  // tomorrow 00:00 + 24h
 *     }
 *     setGegeven('kwhvrij', newKwhvrij);
 *
 *   READ (legacy dispVerbruik.php, check_in_out.php):
 *     kwhVrij     = kwhvrij / kwhpulsen                    // pulses -> kWh
 *     free_e_use  = kwhVrij * aantaldagen
 *     verbruik    = currentMeter - e_start
 *     Verschil    = max(0, verbruik - free_e_use)
 *
 *   seconds    = (now - CheckIn) in seconds     // CheckOut is always NULL in our app
 *   aantaldagen = round(seconds / 86400)        // PHP round(); 0 becomes 1
 *
 * Both the manager and the guest API run these functions, so the two pages can
 * never disagree about a guest's free usage.
 *
 * #FREEUSAGEDB
 */

/** Timezone of the legacy PHP server, used for `nextvrijaftrekcheck`. */
const LEGACY_TIMEZONE = process.env.LEGACY_TIMEZONE || 'Europe/Amsterdam';

/**
 * SQL fragment for `aantaldagen`. The elapsed time is computed inside MySQL
 * because the legacy system writes CheckIn with MySQL's now(); measuring the
 * delta in SQL avoids timezone shifts between the Node process and the DB.
 * The `r` alias is the `reservering` table. Maximum one day, minimum one day.
 */
export const FREE_DAYS_SQL = 'GREATEST(1, ROUND(TIMESTAMPDIFF(SECOND, r.CheckIn, NOW()) / 86400))';

/** Two decimals, the precision the UI shows. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * #FREEUSAGEDB Reads `gegevens.kwhvrij` as kWh.
 *
 * The column holds pulses, so it is divided by `gegevens.kwhpulsen`. A pitch
 * without a known pulse rate falls back to the raw column value, as the legacy
 * code did by simply skipping the division.
 */
export function readFreeUsageKwh(kwhvrij: number | null, kwhpulsen: number | null): number {
  const pulses = kwhvrij ?? 0;
  if (!kwhpulsen) return round2(pulses);
  return round2(pulses / kwhpulsen);
}

/**
 * #FREEUSAGEDB Converts a free-usage value in kWh to the pulse count that
 * `gegevens.kwhvrij` expects. The column is int(10), so the product is rounded.
 */
export function freeUsageKwhToPulses(kWh: number, kwhpulsen: number | null): number {
  return Math.round(kWh * (kwhpulsen ?? 0));
}

/** Offset of a timezone from UTC, in milliseconds, at the given instant. */
function zoneOffsetMs(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);

  const value: Record<string, string> = {};
  for (const part of parts) value[part.type] = part.value;

  const asUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour) % 24,
    Number(value.minute),
    Number(value.second),
  );
  return asUtc - at.getTime();
}

/**
 * #FREEUSAGEDB `nextvrijaftrekcheck`: tomorrow 00:00:00 in the legacy PHP
 * server's timezone + 24h, stored as Unix seconds (the column is int(10)).
 */
export function nextFreeCheckAt(
  now: Date = new Date(),
  timeZone: string = LEGACY_TIMEZONE,
): number {
  // Local calendar date in the legacy timezone, then step to the next day.
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);

  const guess = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));

  // First approximation, then correct for the offset that actually applies at
  // that instant, so a DST switch on the target night is handled too.
  const offsetBefore = zoneOffsetMs(timeZone, guess);
  const midnight = new Date(guess.getTime() - offsetBefore);
  const offsetAfter = zoneOffsetMs(timeZone, midnight);

  return Math.round((midnight.getTime() - (offsetAfter - offsetBefore)) / 1000);
}

export interface FreeUsageSource {
  /** #FREEUSAGEDB `gegevens.kwhvrij` — the free allowance, in pulses. */
  kwhvrij: number | null;
  /** #FREEUSAGEDB `gegevens.kwhpulsen` — pulses per kWh for this meter. */
  kwhpulsen: number | null;
  /** Result of {@link FREE_DAYS_SQL}; anything below 1 is raised to 1. */
  freeDays: number;
  /** `reservering.e_start` — meter reading at check-in. */
  eStart: number | null;
  /** Current meter total: COALESCE(NULLIF(kWhtotaal, 0), kwhtot). */
  currentMeter: number;
}

export interface FreeUsage {
  /** Stay length in days, minimum 1. */
  freeDays: number;
  /** Free allowance for a single day, in kWh, rounded to 2 decimals. */
  freeUsagePerDay: number;
  /** Free allowance for the whole stay, in kWh (legacy `free_e_use`). */
  freeUsageTotal: number;
  /** Amount to invoice, in kWh, never below 0 (legacy `Verschil`). */
  difference: number;
}

export function computeFreeUsage(source: FreeUsageSource): FreeUsage {
  const freeDays = Math.max(1, Math.round(source.freeDays || 0));

  // #FREEUSAGEDB kwhvrij is pulses; the daily allowance is kwhvrij / kwhpulsen.
  // Rounded to 2 decimals, so a pulse-only value (4 / 2000) counts as 0 and the
  // "Vrij verbruik" rows are not shown — the same rule the UI applies.
  const freeUsagePerDay = readFreeUsageKwh(source.kwhvrij, source.kwhpulsen);
  const freeUsageTotal = round2(freeUsagePerDay * freeDays);

  const used = source.currentMeter - (source.eStart ?? 0);
  const difference = round2(used - freeUsageTotal);

  return {
    freeDays,
    freeUsagePerDay,
    freeUsageTotal,
    difference: difference < 0 ? 0 : difference,
  };
}

/**
 * The write side of legacy veld.php, as a plan the caller executes in one
 * transaction. Kept pure so the sequence can be unit-tested without a database.
 */
export interface FreeUsageWritePlan {
  /** Value for `gegevens.kwhvrij`. */
  newKwhvrij: number;
  /** #FREEUSAGEDB true when the value differs from `kwhvrijprev`. */
  updatePrev: boolean;
  /** #FREEUSAGEDB `nextvrijaftrekcheck`, only set when `updatePrev` is true. */
  nextFreeCheckAt: number | null;
}

export function planFreeUsageWrite({
  kWh,
  kwhpulsen,
  kwhvrijprev,
  now,
  timeZone,
}: {
  /** Value chosen in the UI, in kWh. */
  kWh: number | null | undefined;
  /** #FREEUSAGEDB `gegevens.kwhpulsen`. */
  kwhpulsen: number | null;
  /** #FREEUSAGEDB `gegevens.kwhvrijprev` — the comparison value, not kwhvrij. */
  kwhvrijprev: number | null;
  now?: Date;
  timeZone?: string;
}): FreeUsageWritePlan {
  // #FREEUSAGEDB The legacy form keeps the previous value when the field is
  // not submitted; do the same instead of zeroing the allowance.
  const newKwhvrij = kWh == null ? kwhvrijprev ?? 0 : freeUsageKwhToPulses(kWh, kwhpulsen);
  const prev = kwhvrijprev ?? 0;
  const updatePrev = newKwhvrij !== prev;

  return {
    newKwhvrij,
    updatePrev,
    nextFreeCheckAt: updatePrev ? nextFreeCheckAt(now, timeZone) : null,
  };
}

/** The subset of a mysql2 connection this module needs. */
export interface SqlConnection {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  execute(sql: string, params?: any): Promise<unknown>;
}

/**
 * Runs a {@link FreeUsageWritePlan} against the `gegevens` table in a single
 * transaction, following legacy veld.php. Split out from the controller so the
 * statement order and parameters can be unit-tested without a database.
 */
export async function applyFreeUsageWrite(
  connection: SqlConnection,
  pitchId: number,
  plan: FreeUsageWritePlan,
): Promise<void> {
  try {
    await connection.beginTransaction();

    if (plan.updatePrev) {
      // #FREEUSAGEDB kwhvrijprev + nextvrijaftrekcheck (Unix seconds).
      await connection.execute(
        'UPDATE gegevens SET kwhvrijprev = ?, nextvrijaftrekcheck = ? WHERE pltsnr = ?',
        [plan.newKwhvrij, plan.nextFreeCheckAt, pitchId],
      );
    }

    // #FREEUSAGEDB kwhvrij is always written, in pulses.
    await connection.execute('UPDATE gegevens SET kwhvrij = ? WHERE pltsnr = ?', [
      plan.newKwhvrij,
      pitchId,
    ]);

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}