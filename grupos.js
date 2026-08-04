const { round2, LIMITE_ACUMULO } = require('./calculo');

/**
 * Recalcula pis/cofins/csll/irpj/valor_liquido de TODAS as NFs de um grupo
 * (mesmo CNPJ + mesma data_emissao + mesma empresa), a partir dos valores
 * brutos já gravados em cada linha. Deve ser chamado depois de qualquer
 * INSERT ou DELETE que afete um grupo (upload de planilha, lançamento manual,
 * exclusão de NF) para manter o limite de R$10 sempre correto.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {{ cnpjNorm: string, dataEmissao: string, empresaId: number }} grupo
 */
async function recalcularGrupo(db, { cnpjNorm, dataEmissao, empresaId }) {
  if (!cnpjNorm) return; // sem CNPJ não dá para agrupar - cada linha fica isolada (já é o comportamento correto)

  const { rows } = await db.query(
    `SELECT id, valor, iss, pis_bruto, cofins_bruto, csll_bruto, irpj_bruto
     FROM notas_fiscais
     WHERE cnpj_norm = $1 AND data_emissao = $2 AND empresa_id = $3`,
    [cnpjNorm, dataEmissao, empresaId]
  );
  if (!rows.length) return;

  const somaConjunta = round2(
    rows.reduce((s, r) => s + Number(r.pis_bruto) + Number(r.cofins_bruto) + Number(r.csll_bruto), 0)
  );
  const somaIrpj = round2(rows.reduce((s, r) => s + Number(r.irpj_bruto), 0));

  const liberaConjunto = somaConjunta > LIMITE_ACUMULO;
  const liberaIrpj = somaIrpj > LIMITE_ACUMULO;

  for (const r of rows) {
    const pis = liberaConjunto ? Number(r.pis_bruto) : 0;
    const cofins = liberaConjunto ? Number(r.cofins_bruto) : 0;
    const csll = liberaConjunto ? Number(r.csll_bruto) : 0;
    const irpj = liberaIrpj ? Number(r.irpj_bruto) : 0;
    const valorLiquido = round2(Number(r.valor) - pis - cofins - csll - irpj - Number(r.iss));

    await db.query(
      `UPDATE notas_fiscais SET pis = $1, cofins = $2, csll = $3, irpj = $4, valor_liquido = $5 WHERE id = $6`,
      [pis, cofins, csll, irpj, valorLiquido, r.id]
    );
  }
}

/**
 * Recalcula vários grupos de uma vez, evitando repetir o mesmo grupo (cnpjNorm+data+empresa).
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {Array<{ cnpjNorm: string, dataEmissao: string, empresaId: number }>} grupos
 */
async function recalcularGrupos(db, grupos) {
  const vistos = new Set();
  for (const g of grupos) {
    if (!g.cnpjNorm) continue;
    const chave = `${g.cnpjNorm}|${g.dataEmissao}|${g.empresaId}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    await recalcularGrupo(db, g);
  }
}

module.exports = { recalcularGrupo, recalcularGrupos };
