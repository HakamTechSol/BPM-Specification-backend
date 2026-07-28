const { getPool } = require('./src/utils/db');

(async () => {
  try {
    const pool = getPool();
    const [rows] = await pool.execute('SELECT pltsnr, pltsnm, iverb FROM gegevens WHERE pltsnr = 9001');
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
