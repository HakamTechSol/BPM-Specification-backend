// Live check of the legacy free-usage write sequence against the local dev DB.
// Changes ONE test pitch, verifies the columns, then restores the exact
// original values of kwhvrij, kwhvrijprev and nextvrijaftrekcheck.
const mysql = require("mysql2/promise");
require("dotenv").config({ path: "E:/Office Projects/BPM_Specification_V01/backend/.env" });

const PITCH = Number(process.env.TEST_PITCH || 67);
const COLUMNS = "kwhvrij, kwhvrijprev, nextvrijaftrekcheck, kwhpulsen";

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });

  const read = async (id) => {
    const [rows] = await pool.query(`SELECT ${COLUMNS} FROM gegevens WHERE pltsnr = ?`, [id]);
    return rows[0];
  };

  const original = await read(PITCH);
  console.log(`test pitch ${PITCH} — original:`, JSON.stringify(original));

  // Run the real handler logic through the same helpers the API uses.
  const { planFreeUsageWrite, readFreeUsageKwh, computeFreeUsage } = await import(
    "./dist/utils/freeUsage.js"
  );

  const write = async (kWh) => {
    const row = await read(PITCH);
    const plan = planFreeUsageWrite({ kWh, kwhpulsen: row.kwhpulsen, kwhvrijprev: row.kwhvrijprev });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      if (plan.updatePrev) {
        await connection.query(
          "UPDATE gegevens SET kwhvrijprev = ?, nextvrijaftrekcheck = ? WHERE pltsnr = ?",
          [plan.newKwhvrij, plan.nextFreeCheckAt, PITCH],
        );
      }
      await connection.query("UPDATE gegevens SET kwhvrij = ? WHERE pltsnr = ?", [
        plan.newKwhvrij,
        PITCH,
      ]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return plan;
  };

  console.log("\n1) write 4 kWh (pulsen %d)", original.kwhpulsen);
  const first = await write(4);
  console.log("   plan:", JSON.stringify(first));
  console.log("   row :", JSON.stringify(await read(PITCH)));

  console.log("\n2) write the same 4 kWh again");
  const second = await write(4);
  console.log("   plan:", JSON.stringify(second));
  const afterSecond = await read(PITCH);
  console.log("   row :", JSON.stringify(afterSecond));
  console.log(
    `   kwhvrijprev untouched: ${afterSecond.kwhvrijprev === (await read(PITCH)).kwhvrijprev}`,
  );

  console.log("\n3) write 2.5 kWh");
  await write(2.5);
  console.log("   row :", JSON.stringify(await read(PITCH)));

  const current = await read(PITCH);
  console.log(
    "\n   API read back (kWh):",
    readFreeUsageKwh(current.kwhvrij, current.kwhpulsen),
  );
  console.log(
    "   usage table rows:",
    JSON.stringify(
      computeFreeUsage({
        kwhvrij: current.kwhvrij,
        kwhpulsen: current.kwhpulsen,
        freeDays: 3,
        eStart: 1000,
        currentMeter: 1040,
      }),
    ),
  );

  console.log("\n--- restoring original values ---");
  await pool.query(
    "UPDATE gegevens SET kwhvrij = ?, kwhvrijprev = ?, nextvrijaftrekcheck = ? WHERE pltsnr = ?",
    [original.kwhvrij, original.kwhvrijprev, original.nextvrijaftrekcheck, PITCH],
  );
  const restored = await read(PITCH);
  console.log("   restored:", JSON.stringify(restored));
  console.log(
    "   exact match:",
    restored.kwhvrij === original.kwhvrij &&
      restored.kwhvrijprev === original.kwhvrijprev &&
      restored.nextvrijaftrekcheck === original.nextvrijaftrekcheck,
  );

  console.log("\n--- pitches still holding small raw values ---");
  const [raw] = await pool.query(
    "SELECT pltsnr, kwhvrij, kwhvrijprev, kwhpulsen, kwhvrij / NULLIF(kwhpulsen, 0) AS kwh FROM gegevens WHERE pltsnr < 1000 AND kwhvrij > 0 ORDER BY pltsnr",
  );
  console.table(raw);

  await pool.end();
}

main().catch((error) => {
  console.error("FAILED", error.message);
  process.exit(1);
});