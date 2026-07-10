const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/codigos-servico', async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: codigos } = await pool.query(`
    SELECT c.*, e.nome AS empresa_nome
    FROM codigos_servico c
    JOIN empresas e ON e.id = c.empresa_id
    ORDER BY e.nome, c.codigo
  `);
  res.render('codigos-servico', { empresas, codigos, erro: null, sucesso: req.query.ok === '1' });
});

router.post('/codigos-servico', async (req, res) => {
  try {
    const { empresaId, codigo, descricao } = req.body;
    if (!empresaId || !codigo) {
      const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
      const { rows: codigos } = await pool.query(`
        SELECT c.*, e.nome AS empresa_nome FROM codigos_servico c JOIN empresas e ON e.id = c.empresa_id ORDER BY e.nome, c.codigo
      `);
      return res.render('codigos-servico', { empresas, codigos, erro: 'Selecione a empresa e informe o código.', sucesso: false });
    }
    await pool.query(
      `INSERT INTO codigos_servico (empresa_id, codigo, descricao)
       VALUES ($1, $2, $3)
       ON CONFLICT (empresa_id, codigo) DO UPDATE SET descricao = $3`,
      [empresaId, codigo.trim(), (descricao || '').trim() || null]
    );
    res.redirect('/codigos-servico?ok=1');
  } catch (err) {
    console.error(err);
    const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
    const { rows: codigos } = await pool.query(`
      SELECT c.*, e.nome AS empresa_nome FROM codigos_servico c JOIN empresas e ON e.id = c.empresa_id ORDER BY e.nome, c.codigo
    `);
    res.render('codigos-servico', { empresas, codigos, erro: 'Erro ao salvar o código de serviço.', sucesso: false });
  }
});

router.post('/codigos-servico/excluir', async (req, res) => {
  try {
    const { id } = req.body;
    await pool.query('DELETE FROM codigos_servico WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, erro: 'Erro ao excluir o código.' });
  }
});

module.exports = router;
