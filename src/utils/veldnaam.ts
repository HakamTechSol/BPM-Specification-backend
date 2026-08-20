import { RowDataPacket } from 'mysql2';
import { getPool } from './db';

interface SitesettingsRow extends RowDataPacket {
  key_name: string;
  value_json: string;
}

let cachedMap: Record<number, string> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

export async function getVeldnaamMap(): Promise<Record<number, string>> {
  const now = Date.now();
  if (cachedMap && now < cacheExpiry) return cachedMap;

  try {
    const pool = getPool();
    const [rows] = await pool.execute<SitesettingsRow[]>(
      "SELECT value_json FROM sitesettings WHERE key_name = 'veldnaam'"
    );
    if (rows.length > 0) {
      const parsed = JSON.parse(rows[0].value_json);
      cachedMap = Object.fromEntries(
        Object.entries(parsed).map(([k, v]) => [Number(k), String(v)])
      );
    } else {
      cachedMap = {};
    }
  } catch {
    cachedMap = {};
  }

  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return cachedMap!;
}
