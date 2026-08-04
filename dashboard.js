const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
  const { empresa, dataDe, dataAte } = req.query;

  const where = [];
  const params = [];
  if (empresa) {
    params.push(empresa);
    where.push(`n.empresa_id = $${params.length}`);
  }
  if (dataDe) {
    params.push(dataDe);
    where.push(`n.data_emissao >= $${params.length}`);
  }
  if (dataAte) {
    params.push(dataAte);
    where.push(`n.data_emissao <= $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');

  const resumoSql = `
    SELECT
      COUNT(*)::int AS qtd,
      COALESCE(SUM(n.valor),0)::float AS valor,
      COALESCE(SUM(n.pis),0)::float AS pis,
      COALESCE(SUM(n.cofins),0)::float AS cofins,
      COALESCE(SUM(n.csll),0)::float AS csll,
      COALESCE(SUM(n.irpj),0)::float AS irpj,
      COALESCE(SUM(n.iss),0)::float AS iss,
      COALESCE(SUM(n.valor_liquido),0)::float AS valor_liquido
    FROM notas_fiscais n ${whereSql}
  `;
  const { rows: resumoRows } = await pool.query(resumoSql, params);
  const resumo = resumoRows[0];
  resumo.total_impostos = round2(resumo.pis + resumo.cofins + resumo.csll + resumo.irpj + resumo.iss);

  const porEmpresaSql = `
    SELECT e.nome AS empresa, e.slug,
      COALESCE(SUM(n.valor),0)::float AS valor,
      COALESCE(SUM(n.pis + n.cofins + n.csll + n.irpj + n.iss),0)::float AS impostos,
      COUNT(*)::int AS qtd
    FROM notas_fiscais n
    JOIN empresas e ON e.id = n.empresa_id
    ${whereSql}
    GROUP BY e.nome, e.slug
    ORDER BY e.nome
  `;
  const { rows: porEmpresa } = await pool.query(porEmpresaSql, params);

  const porMesSql = `
    SELECT to_char(date_trunc('month', n.data_emissao), 'YYYY-MM') AS mes,
      COALESCE(SUM(n.valor),0)::float AS valor,
      COALESCE(SUM(n.pis + n.cofins + n.csll + n.irpj + n.iss),0)::float AS impostos
    FROM notas_fiscais n
    ${whereSql}
    GROUP BY 1
    ORDER BY 1
  `;
  const { rows: porMes } = await pool.query(porMesSql, params);

  res.render('dashboard', {
    empresas,
    filtros: { empresa, dataDe, dataAte },
    resumo,
    porEmpresa,
    porMes: JSON.stringify(porMes),
    impostosBreakdown: JSON.stringify([
      { nome: 'PIS', valor: resumo.pis },
      { nome: 'COFINS', valor: resumo.cofins },
      { nome: 'CSLL', valor: resumo.csll },
      { nome: 'IRPJ', valor: resumo.irpj },
      { nome: 'ISS', valor: resumo.iss }
    ])
  });
});

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = router;
