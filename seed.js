require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

async function seed() {
  const username = process.env.ADMIN_USERNAME || 'eity';
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    console.error('Defina ADMIN_PASSWORD no .env antes de rodar o seed.');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = $2`,
    [username, hash]
  );

  console.log(`Usuário "${username}" criado/atualizado com sucesso.`);
  await pool.end();
}

seed().catch((err) => {
  console.error('Erro no seed:', err);
  process.exit(1);
});
