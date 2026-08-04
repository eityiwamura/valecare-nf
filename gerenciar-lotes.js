require('dotenv').config();
const pool = require('../db/pool');

async function listar() {
  const { rows } = await pool.query(`
    SELECT l.id, e.nome AS empresa, l.arquivo_nome, l.data_emissao,
           l.total_linhas, l.iss_aliquota, l.created_at
    FROM lotes l
    JOIN empresas e ON e.id = l.empresa_id
    ORDER BY l.created_at DESC
  `);
  if (!rows.length) {
    console.log('Nenhum lote encontrado.');
    return;
  }
  console.log('ID  | Empresa              | Arquivo                        | Emissão    | Linhas | ISS%  | Enviado em');
  console.log('-'.repeat(110));
  rows.forEach((r) => {
    console.log(
      String(r.id).padEnd(4) + '| ' +
      r.empresa.padEnd(21) + '| ' +
      (r.arquivo_nome || '').slice(0, 30).padEnd(32) + '| ' +
      new Date(r.data_emissao).toISOString().slice(0, 10).padEnd(11) + '| ' +
      String(r.total_linhas).padEnd(7) + '| ' +
      String(r.iss_aliquota).padEnd(6) + '| ' +
      new Date(r.created_at).toLocaleString('pt-BR')
    );
  });
}

async function excluir(id) {
  if (!id) {
    console.error('Uso: node scripts/gerenciar-lotes.js excluir <ID_DO_LOTE>');
    process.exit(1);
  }
  const { rows } = await pool.query('SELECT * FROM lotes WHERE id = $1', [id]);
  if (!rows.length) {
    console.error(`Lote ${id} não encontrado.`);
    process.exit(1);
  }
  const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS total FROM notas_fiscais WHERE lote_id = $1', [id]);
  await pool.query('DELETE FROM lotes WHERE id = $1', [id]); // cascade remove as notas_fiscais do lote
  console.log(`Lote ${id} excluído, junto com ${countRows[0].total} nota(s) fiscal(is) vinculada(s).`);
}

async function main() {
  const [comando, arg] = process.argv.slice(2);
  if (comando === 'listar') {
    await listar();
  } else if (comando === 'excluir') {
    await excluir(arg);
  } else {
    console.log('Uso:');
    console.log('  node scripts/gerenciar-lotes.js listar');
    console.log('  node scripts/gerenciar-lotes.js excluir <ID_DO_LOTE>');
  }
  await pool.end();
}

main().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
