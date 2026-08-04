require('dotenv').config();
const pool = require('../db/pool');

async function zerar() {
  const confirmar = process.argv.includes('--confirmar');
  if (!confirmar) {
    console.log('Isso vai apagar TODAS as notas fiscais e lotes enviados (mantém usuários, empresas e alíquotas de ISS configuradas).');
    console.log('Para confirmar, rode: npm run banco:zerar -- --confirmar');
    process.exit(0);
  }

  const { rows: countNf } = await pool.query('SELECT COUNT(*)::int AS total FROM notas_fiscais');
  const { rows: countLotes } = await pool.query('SELECT COUNT(*)::int AS total FROM lotes');

  await pool.query('TRUNCATE TABLE notas_fiscais RESTART IDENTITY');
  await pool.query('TRUNCATE TABLE lotes RESTART IDENTITY CASCADE');

  console.log(`Banco zerado: ${countNf[0].total} nota(s) fiscal(is) e ${countLotes[0].total} lote(s) removidos.`);
  console.log('Usuários, empresas e alíquotas de ISS configuradas foram mantidos.');
  await pool.end();
}

zerar().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
