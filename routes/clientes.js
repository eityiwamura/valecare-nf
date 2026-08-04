const express = require('express');
const pool = require('../db/pool');
const { onlyDigits } = require('../services/calculo');
const { buscarClienteAPI, salvarCliente } = require('../services/clientes');

const router = express.Router();

router.get('/clientes', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 10;
  const offset = (page - 1) * pageSize;
  const { busca, tipo } = req.query;

  const where = [];
  const params = [];
  if (busca) {
    params.push(`%${busca}%`);
    const idx = params.length;
    params.push(`%${onlyDigits(busca)}%`);
    const idxDigits = params.length;
    where.push(`(razao_social ILIKE $${idx} OR cidade ILIKE $${idx} OR cnpj ILIKE $${idxDigits})`);
  }
  if (tipo === 'cnpj' || tipo === 'cpf') {
    params.push(tipo);
    where.push(`tipo_documento = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes ${whereSql}`, params);
  const total = countRows[0].total;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const { rows: clientes } = await pool.query(
    `SELECT * FROM clientes ${whereSql} ORDER BY atualizado_em DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );

  res.render('clientes', {
    clientes,
    total,
    page,
    totalPages,
    filtros: { busca, tipo },
    erro: null,
    sucesso: req.query.ok === '1'
  });
});

router.post('/clientes/:id', async (req, res) => {
  try {
    const {
      razaoSocial, logradouro, numero, complemento, bairro, cep,
      codigoIbge, cidade, uf, simplesNacional
    } = req.body;

    const { rows } = await pool.query(
      `UPDATE clientes SET
        razao_social = $1, logradouro = $2, numero = $3, complemento = $4, bairro = $5,
        cep = $6, codigo_ibge = $7, cidade = $8, uf = $9, simples_nacional = $10,
        fonte = 'manual', atualizado_em = now()
       WHERE id = $11
       RETURNING *`,
      [
        razaoSocial || null, logradouro || null, numero || null, complemento || null, bairro || null,
        cep || null, codigoIbge || null, cidade || null, uf || null, simplesNacional || null,
        req.params.id
      ]
    );
    res.json({ ok: true, cliente: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar as alterações.' });
  }
});

router.post('/clientes/:id/excluir', async (req, res) => {
  try {
    await pool.query('DELETE FROM clientes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir o cliente.' });
  }
});

// Força uma nova consulta na Receita Federal, ignorando o que já está no cadastro
// (útil quando a primeira consulta veio incompleta, ex: por limite de requisições)
router.post('/clientes/:id/reconsultar', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    const cliente = rows[0];
    if (!cliente) return res.status(404).json({ ok: false, erro: 'Cliente não encontrado.' });
    if (cliente.tipo_documento === 'cpf') {
      return res.status(400).json({ ok: false, erro: 'CPF não tem consulta automática — edite manualmente.' });
    }

    const dadosApi = await buscarClienteAPI(cliente.cnpj);
    const salvo = await salvarCliente(pool, cliente.cnpj, dadosApi, 'api', 'cnpj');
    res.json({ ok: true, cliente: salvo, regimeConhecido: dadosApi.regimeConhecido });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;
