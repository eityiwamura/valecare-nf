const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// ---------- Nível 1: Código de Serviço ----------

router.get('/codigos-servico', async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: codigos } = await pool.query(`
    SELECT c.*, e.nome AS empresa_nome,
      (SELECT COUNT(*) FROM nbs n WHERE n.codigo_servico_id = c.id)::int AS total_nbs
    FROM codigos_servico c
    JOIN empresas e ON e.id = c.empresa_id
    ORDER BY e.nome, c.codigo
  `);
  res.render('codigos-servico', { empresas, codigos, erro: null });
});

router.post('/codigos-servico', async (req, res) => {
  try {
    const { empresaId, codigo, descricao } = req.body;
    if (!empresaId || !codigo) {
      return res.status(400).json({ ok: false, erro: 'Selecione a empresa e informe o código.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO codigos_servico (empresa_id, codigo, descricao)
       VALUES ($1, $2, $3)
       ON CONFLICT (empresa_id, codigo) DO UPDATE SET descricao = $3
       RETURNING *`,
      [empresaId, codigo.trim(), (descricao || '').trim() || null]
    );
    res.json({ ok: true, codigo: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar o código de serviço.' });
  }
});

router.post('/codigos-servico/excluir', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM codigos_servico WHERE id = $1', [id]); // cascade remove NBS/indicadores/classificações
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir o código.' });
  }
});

// ---------- Nível 2: NBS (dentro de um Código de Serviço) ----------

router.get('/codigos-servico/:id/nbs', async (req, res) => {
  const { rows: codigoRows } = await pool.query(
    `SELECT c.*, e.nome AS empresa_nome FROM codigos_servico c JOIN empresas e ON e.id = c.empresa_id WHERE c.id = $1`,
    [req.params.id]
  );
  if (!codigoRows.length) return res.redirect('/codigos-servico');
  const { rows: nbsList } = await pool.query(`
    SELECT n.*, (SELECT COUNT(*) FROM indicadores_operacao i WHERE i.nbs_id = n.id)::int AS total_indicadores
    FROM nbs n WHERE n.codigo_servico_id = $1 ORDER BY n.codigo
  `, [req.params.id]);
  res.render('nbs', { codigoServico: codigoRows[0], nbsList, erro: null });
});

router.post('/nbs', async (req, res) => {
  try {
    const { codigoServicoId, codigo, descricao } = req.body;
    if (!codigoServicoId || !codigo) {
      return res.status(400).json({ ok: false, erro: 'Informe o código NBS.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO nbs (codigo_servico_id, codigo, descricao) VALUES ($1,$2,$3)
       ON CONFLICT (codigo_servico_id, codigo) DO UPDATE SET descricao = $3
       RETURNING *`,
      [codigoServicoId, codigo.trim(), (descricao || '').trim() || null]
    );
    res.json({ ok: true, nbs: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar o NBS.' });
  }
});

router.post('/nbs/excluir', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM nbs WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir o NBS.' });
  }
});

// ---------- Nível 3: Indicador de Operação (dentro de um NBS) ----------

router.get('/nbs/:id/indicadores', async (req, res) => {
  const { rows: nbsRows } = await pool.query(`
    SELECT n.*, c.codigo AS codigo_servico_codigo, c.id AS codigo_servico_id, c.empresa_id
    FROM nbs n JOIN codigos_servico c ON c.id = n.codigo_servico_id WHERE n.id = $1
  `, [req.params.id]);
  if (!nbsRows.length) return res.redirect('/codigos-servico');
  const { rows: indicadores } = await pool.query(`
    SELECT i.*, (SELECT COUNT(*) FROM classificacoes_tributarias ct WHERE ct.indicador_operacao_id = i.id)::int AS total_classificacoes
    FROM indicadores_operacao i WHERE i.nbs_id = $1 ORDER BY i.codigo
  `, [req.params.id]);
  res.render('indicadores', { nbs: nbsRows[0], indicadores, erro: null });
});

router.post('/indicadores', async (req, res) => {
  try {
    const { nbsId, codigo, descricao } = req.body;
    if (!nbsId || !codigo) {
      return res.status(400).json({ ok: false, erro: 'Informe o indicador de operação.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO indicadores_operacao (nbs_id, codigo, descricao) VALUES ($1,$2,$3)
       ON CONFLICT (nbs_id, codigo) DO UPDATE SET descricao = $3
       RETURNING *`,
      [nbsId, codigo.trim(), (descricao || '').trim() || null]
    );
    res.json({ ok: true, indicador: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar o indicador.' });
  }
});

router.post('/indicadores/excluir', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM indicadores_operacao WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir o indicador.' });
  }
});

// ---------- Nível 4: Classificação Tributária (dentro de um Indicador de Operação) ----------

router.get('/indicadores/:id/classificacoes', async (req, res) => {
  const { rows: indicadorRows } = await pool.query(`
    SELECT i.*, n.codigo AS nbs_codigo, n.id AS nbs_id, c.codigo AS codigo_servico_codigo
    FROM indicadores_operacao i
    JOIN nbs n ON n.id = i.nbs_id
    JOIN codigos_servico c ON c.id = n.codigo_servico_id
    WHERE i.id = $1
  `, [req.params.id]);
  if (!indicadorRows.length) return res.redirect('/codigos-servico');
  const { rows: classificacoes } = await pool.query(
    'SELECT * FROM classificacoes_tributarias WHERE indicador_operacao_id = $1 ORDER BY codigo',
    [req.params.id]
  );
  res.render('classificacoes', { indicador: indicadorRows[0], classificacoes, erro: null });
});

router.post('/classificacoes', async (req, res) => {
  try {
    const { indicadorOperacaoId, codigo, descricao } = req.body;
    if (!indicadorOperacaoId || !codigo) {
      return res.status(400).json({ ok: false, erro: 'Informe a classificação tributária.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO classificacoes_tributarias (indicador_operacao_id, codigo, descricao) VALUES ($1,$2,$3)
       ON CONFLICT (indicador_operacao_id, codigo) DO UPDATE SET descricao = $3
       RETURNING *`,
      [indicadorOperacaoId, codigo.trim(), (descricao || '').trim() || null]
    );
    res.json({ ok: true, classificacao: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao salvar a classificação.' });
  }
});

router.post('/classificacoes/excluir', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM classificacoes_tributarias WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir a classificação.' });
  }
});

module.exports = router;
