require('dotenv').config();
const pool = require('../db/pool');
const { resolverCliente } = require('../services/clientes');

/**
 * Encontra todos os clientes (CNPJ) com cadastro incompleto — sem cidade, sem
 * código IBGE ou sem regime tributário confirmado — e consulta a Receita de
 * novo pra cada um, um a um (cada consulta já tem suas próprias tentativas em
 * caso de limite de requisições). Não mexe em CPF (não tem consulta automática).
 *
 * Uso: node scripts/reconciliar-clientes.js
 */
async function reconciliar() {
  const { rows: incompletos } = await pool.query(`
    SELECT cnpj, razao_social FROM clientes
    WHERE tipo_documento = 'cnpj'
      AND (cidade IS NULL OR cidade = '' OR codigo_ibge IS NULL OR codigo_ibge = '' OR simples_nacional IS NULL OR simples_nacional = '')
    ORDER BY razao_social
  `);

  if (!incompletos.length) {
    console.log('Nenhum cliente com cadastro incompleto encontrado. Nada a fazer.');
    await pool.end();
    return;
  }

  console.log(`Encontrados ${incompletos.length} cliente(s) com cadastro incompleto. Reconciliando um por um...\n`);

  let ok = 0;
  let falhas = 0;
  for (const c of incompletos) {
    try {
      const antes = await pool.query('SELECT cidade, codigo_ibge, simples_nacional FROM clientes WHERE cnpj = $1', [c.cnpj]);
      await resolverCliente(pool, c.cnpj);
      const depois = await pool.query('SELECT cidade, codigo_ibge, simples_nacional FROM clientes WHERE cnpj = $1', [c.cnpj]);
      console.log(`✓ ${c.razao_social || c.cnpj} (${c.cnpj}) — cidade: "${depois.rows[0].cidade || ''}", IBGE: "${depois.rows[0].codigo_ibge || ''}", regime: "${depois.rows[0].simples_nacional || '(não confirmado)'}"`);
      ok++;
    } catch (err) {
      console.warn(`✗ ${c.razao_social || c.cnpj} (${c.cnpj}) — falhou: ${err.message}`);
      falhas++;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\nConcluído: ${ok} corrigido(s), ${falhas} falha(s) de ${incompletos.length}.`);
  console.log('Observação: isso só corrige o CADASTRO DE CLIENTES. Notas fiscais já emitidas com cidade em branco');
  console.log('continuam com a cidade em branco no banco, mas a exportação já usa o cadastro corrigido como reserva.');
  await pool.end();
}

reconciliar().catch((err) => {
  console.error('Erro:', err.message);
  process.exit(1);
});
