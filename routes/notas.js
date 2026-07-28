const express = require('express');
const pool = require('../db/pool');
const { calcularBrutoLinha } = require('../services/calculo');
const { recalcularGrupo, recalcularGrupos } = require('../services/grupos');
const { resolverCliente } = require('../services/clientes');

const router = express.Router();

const SORT_MAP = {
  vencimento: 'n.vencimento',
  data_emissao: 'n.data_emissao',
  cliente: 'n.cliente',
  cidade: 'n.cidade',
  valor: 'n.valor',
  pis: 'n.pis',
  cofins: 'n.cofins',
  csll: 'n.csll',
  irpj: 'n.irpj',
  iss: 'n.iss',
  valor_liquido: 'n.valor_liquido'
};

router.get('/lista', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;

  const { empresa, cliente, cidade, simples, dataDe, dataAte } = req.query;
  const sortKey = SORT_MAP[req.query.sort] ? req.query.sort : 'data_emissao';
  const sortCol = SORT_MAP[sortKey];
  const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const where = [];
  const params = [];

  if (empresa) {
    params.push(empresa);
    where.push(`n.empresa_id = $${params.length}`);
  }
  if (cliente) {
    params.push(`%${cliente}%`);
    where.push(`n.cliente ILIKE $${params.length}`);
  }
  if (cidade) {
    params.push(`%${cidade}%`);
    where.push(`n.cidade ILIKE $${params.length}`);
  }
  if (simples === 'sim') {
    where.push(`n.simples_nacional ILIKE '%simples%'`);
  } else if (simples === 'nao') {
    where.push(`n.simples_nacional NOT ILIKE '%simples%'`);
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

  const countSql = `SELECT COUNT(*)::int AS total FROM notas_fiscais n ${whereSql}`;
  const { rows: countRows } = await pool.query(countSql, params);
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const dataSql = `
    SELECT n.*, e.nome AS empresa_nome
    FROM notas_fiscais n
    JOIN empresas e ON e.id = n.empresa_id
    ${whereSql}
    ORDER BY ${sortCol} ${sortDir}, n.id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;
  const { rows: notas } = await pool.query(dataSql, params);

  const totalsSql = `
    SELECT
      COALESCE(SUM(n.valor),0)::float AS valor,
      COALESCE(SUM(n.pis),0)::float AS pis,
      COALESCE(SUM(n.cofins),0)::float AS cofins,
      COALESCE(SUM(n.csll),0)::float AS csll,
      COALESCE(SUM(n.irpj),0)::float AS irpj,
      COALESCE(SUM(n.iss),0)::float AS iss,
      COALESCE(SUM(n.valor_liquido),0)::float AS valor_liquido
    FROM notas_fiscais n ${whereSql}
  `;
  const { rows: totalsRows } = await pool.query(totalsSql, params);

  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');

  res.render('lista', {
    notas,
    totals: totalsRows[0],
    empresas,
    filtros: { empresa, cliente, cidade, simples, dataDe, dataAte },
    sort: sortKey,
    dir: sortDir.toLowerCase(),
    page,
    totalPages,
    total
  });
});

router.post('/lista/excluir', async (req, res) => {
  try {
    let ids = req.body.ids;
    if (!Array.isArray(ids)) ids = [ids];
    ids = ids.map((id) => parseInt(id, 10)).filter((id) => Number.isInteger(id));

    if (!ids.length) {
      return res.status(400).json({ ok: false, erro: 'Nenhuma nota selecionada.' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Guarda os grupos afetados ANTES de excluir, para recalcular o limite de
      // R$10 das notas que sobrarem (a exclusão pode fazer um grupo cair abaixo do limite).
      const { rows: afetadas } = await client.query(
        'SELECT cnpj_norm, data_emissao, empresa_id FROM notas_fiscais WHERE id = ANY($1::int[])',
        [ids]
      );

      const { rowCount } = await client.query('DELETE FROM notas_fiscais WHERE id = ANY($1::int[])', [ids]);

      await recalcularGrupos(
        client,
        afetadas.map((r) => ({ cnpjNorm: r.cnpj_norm, dataEmissao: r.data_emissao, empresaId: r.empresa_id }))
      );

      await client.query('COMMIT');
      res.json({ ok: true, excluidas: rowCount });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir as notas selecionadas.' });
  }
});

// --- Busca de CNPJ (usado pela tela de lançamento manual via AJAX) ---
router.post('/api/clientes/buscar', async (req, res) => {
  try {
    const { cnpj } = req.body;
    if (!cnpj) return res.status(400).json({ ok: false, erro: 'Informe um CNPJ.' });
    const cliente = await resolverCliente(pool, cnpj);
    res.json({ ok: true, cliente });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

// --- Lançamento manual de uma única NF ---
router.get('/notas/nova', async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: configs } = await pool.query('SELECT * FROM configuracoes');
  const { rows: codigos } = await pool.query('SELECT * FROM codigos_servico ORDER BY codigo');
  const { rows: nbsList } = await pool.query('SELECT * FROM nbs ORDER BY codigo');
  const { rows: indicadores } = await pool.query('SELECT * FROM indicadores_operacao ORDER BY codigo');
  const { rows: classificacoes } = await pool.query('SELECT * FROM classificacoes_tributarias ORDER BY codigo');
  const configMap = {};
  configs.forEach((c) => { configMap[c.empresa_id] = c.iss_aliquota; });
  res.render('nota-manual', {
    empresas,
    configMap,
    codigos,
    nbsList,
    indicadores,
    classificacoes,
    erro: null,
    sucesso: req.query.ok === '1',
    hoje: new Date().toISOString().slice(0, 10)
  });
});

router.post('/notas/nova', async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: configs } = await pool.query('SELECT * FROM configuracoes');
  const { rows: codigos } = await pool.query('SELECT * FROM codigos_servico ORDER BY codigo');
  const { rows: nbsList } = await pool.query('SELECT * FROM nbs ORDER BY codigo');
  const { rows: indicadores } = await pool.query('SELECT * FROM indicadores_operacao ORDER BY codigo');
  const { rows: classificacoes } = await pool.query('SELECT * FROM classificacoes_tributarias ORDER BY codigo');
  const configMap = {};
  configs.forEach((c) => { configMap[c.empresa_id] = c.iss_aliquota; });

  const render = (erro) => res.render('nota-manual', {
    empresas, configMap, codigos, nbsList, indicadores, classificacoes,
    erro, sucesso: false, hoje: new Date().toISOString().slice(0, 10)
  });

  try {
    const {
      empresaId, tipoPessoa, cnpj, cliente, cidade, simplesNacional,
      codigoServico, nbs, indicadorOperacao, classificacaoTributaria,
      descricao, valor, vencimento, dataEmissao, issAliquota
    } = req.body;

    if (!empresaId) return render('Selecione a empresa emissora.');
    const empresa = empresas.find((e) => String(e.id) === String(empresaId));
    if (!empresa) return render('Empresa inválida.');

    if (!cliente) return render('Informe o nome do cliente.');
    if (!cidade) return render('Informe a cidade.');

    const valorNum = parseFloat(String(valor).replace(/\./g, '').replace(',', '.'));
    if (isNaN(valorNum) || valorNum <= 0) return render('Informe um valor de NF válido.');

    const aliquota = parseFloat(String(issAliquota).replace(',', '.'));
    if (isNaN(aliquota) || aliquota < 0) return render('Informe uma alíquota de ISS válida.');

    const dataEmissaoFinal = dataEmissao || new Date().toISOString().slice(0, 10);
    const cnpjLimpo = tipoPessoa === 'cpf' ? '' : String(cnpj || '').replace(/\D/g, '');

    if (tipoPessoa !== 'cpf' && cnpjLimpo.length !== 14) {
      return render('CNPJ inválido — precisa ter 14 dígitos.');
    }

    const linha = {
      simplesNacional: tipoPessoa === 'cpf' ? 'Pessoa Física' : simplesNacional,
      cidade,
      cliente,
      cnpj: cnpjLimpo,
      descricao,
      vencimento: vencimento || null,
      valor: valorNum
    };
    const bruto = calcularBrutoLinha(linha, empresa.slug, aliquota);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO notas_fiscais
          (lote_id, empresa_id, simples_nacional, cidade, cliente, cnpj, cnpj_norm, codigo_servico,
           nbs, indicador_operacao, classificacao_tributaria,
           descricao, vencimento, data_emissao, origem, valor, pis_bruto, cofins_bruto, csll_bruto, irpj_bruto, iss)
         VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual',$14,$15,$16,$17,$18,$19)
         RETURNING id`,
        [
          empresa.id, linha.simplesNacional, cidade, cliente, cnpj || null, bruto.cnpjNorm, codigoServico || null,
          nbs || null, indicadorOperacao || null, classificacaoTributaria || null,
          descricao || null, linha.vencimento, dataEmissaoFinal, valorNum,
          bruto.pisBruto, bruto.cofinsBruto, bruto.csllBruto, bruto.irpjBruto, bruto.iss
        ]
      );

      if (bruto.cnpjNorm) {
        await recalcularGrupo(client, { cnpjNorm: bruto.cnpjNorm, dataEmissao: dataEmissaoFinal, empresaId: empresa.id });
      } else {
        // Pessoa física / sem CNPJ: não agrupa, mas ainda assim precisa gravar valor_liquido
        const valorLiquido = Math.round((valorNum - bruto.iss + Number.EPSILON) * 100) / 100;
        await client.query('UPDATE notas_fiscais SET valor_liquido = $1 WHERE id = $2', [valorLiquido, insertResult.rows[0].id]);
      }

      await client.query('COMMIT');
      res.redirect('/notas/nova?ok=1');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    render('Erro ao salvar a NF: ' + err.message);
  }
});

module.exports = router;
