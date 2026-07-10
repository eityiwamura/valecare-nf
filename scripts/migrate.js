require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('Migração concluída com sucesso.');
  await pool.end();
}

migrate().catch((err) => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
