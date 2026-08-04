const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { parsePlanilha } = require('../services/parser');
const { calcularLoteBruto } = require('../services/calculo');
const { recalcularGrupos } = require('../services/grupos');
const { enriquecerClientesEmSegundoPlano } = require('../services/clientes');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.(xlsx|xls)$/i.test(file.originalname);
    if (!okExt) return cb(new Error('Envie um arquivo .xlsx ou .xls'));
    cb(null, true);
  }
});

router.get('/upload', async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: configs } = await pool.query('SELECT * FROM configuracoes');
  const { rows: codigos } = await pool.query('SELECT * FROM codigos_servico ORDER BY codigo');
  const { rows: nbsList } = await pool.query('SELECT * FROM nbs ORDER BY codigo');
  const { rows: indicadores } = await pool.query('SELECT * FROM indicadores_operacao ORDER BY codigo');
  const { rows: classificacoes } = await pool.query('SELECT * FROM classificacoes_tributarias ORDER BY codigo');
  const configMap = {};
  configs.forEach((c) => { configMap[c.empresa_id] = c.iss_aliquota; });
  res.render('upload', {
    empresas,
    configMap,
    codigos,
    nbsList,
    indicadores,
    classificacoes,
    erro: null,
    sucesso: req.query.ok ? { linhas: req.query.linhas, lote: req.query.lote } : null,
    hoje: new Date().toISOString().slice(0, 10)
  });
});

router.post('/upload', upload.single('planilha'), async (req, res) => {
  const { rows: empresas } = await pool.query('SELECT * FROM empresas ORDER BY nome');
  const { rows: configs } = await pool.query('SELECT * FROM configuracoes');
  const { rows: codigos } = await pool.query('SELECT * FROM codigos_servico ORDER BY codigo');
  const { rows: nbsList } = await pool.query('SELECT * FROM nbs ORDER BY codigo');
  const { rows: indicadores } = await pool.query('SELECT * FROM indicadores_operacao ORDER BY codigo');
  const { rows: classificacoes } = await pool.query('SELECT * FROM classificacoes_tributarias ORDER BY codigo');
  const configMap = {};
  configs.forEach((c) => { configMap[c.empresa_id] = c.iss_aliquota; });

  const render = (erro) => res.render('upload', {
    empresas, configMap, codigos, nbsList, indicadores, classificacoes,
    erro, sucesso: null, hoje: new Date().toISOString().slice(0, 10)
  });

  try {
    const {
      empresaId, issAliquota, dataEmissao,
      codigoServico, nbs, indicadorOperacao, classificacaoTributaria
    } = req.body;
    if (!req.file) return render('Selecione um arquivo .xlsx para enviar.');
    if (!empresaId) return render('Selecione a empresa emissora antes de enviar.');

    const empresa = empresas.find((e) => String(e.id) === String(empresaId));
    if (!empresa) return render('Empresa inválida.');

    const aliquota = parseFloat(String(issAliquota).replace(',', '.'));
    if (isNaN(aliquota) || aliquota < 0) return render('Informe uma alíquota de ISS válida.');

    const dataEmissaoFinal = dataEmissao || new Date().toISOString().slice(0, 10);

    const { rows: linhasBrutas, erros } = parsePlanilha(req.file.buffer, empresa.slug);
    if (!linhasBrutas.length) {
      return render(erros.length ? erros.join(' ') : 'Nenhuma linha válida encontrada na planilha.');
    }

    const calculadas = calcularLoteBruto(linhasBrutas, empresa.slug, aliquota);
    const cnpjsUnicos = [...new Set(calculadas.map((r) => r.cnpjNorm).filter((c) => c && c.length === 14))];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO configuracoes (empresa_id, iss_aliquota, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (empresa_id) DO UPDATE SET iss_aliquota = $2, updated_at = now()`,
        [empresa.id, aliquota]
      );

      const loteResult = await client.query(
        `INSERT INTO lotes (empresa_id, arquivo_nome, iss_aliquota, data_emissao, total_linhas, user_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [empresa.id, req.file.originalname, aliquota, dataEmissaoFinal, calculadas.length, req.session.userId]
      );
      const loteId = loteResult.rows[0].id;

      for (const r of calculadas) {
        await client.query(
          `INSERT INTO notas_fiscais
            (lote_id, empresa_id, simples_nacional, cidade, cliente, cnpj, cnpj_norm, codigo_servico,
             nbs, indicador_operacao, classificacao_tributaria, descricao,
             vencimento, data_emissao, origem, valor, pis_bruto, cofins_bruto, csll_bruto, irpj_bruto, iss)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'upload',$15,$16,$17,$18,$19,$20)`,
          [
            loteId, empresa.id, r.simplesNacional, r.cidade, r.cliente, r.cnpj, r.cnpjNorm, codigoServico || null,
            nbs || null, indicadorOperacao || null, classificacaoTributaria || null, r.descricao,
            r.vencimento, dataEmissaoFinal, r.valor, r.pisBruto, r.cofinsBruto, r.csllBruto, r.irpjBruto, r.iss
          ]
        );
      }

      // Recalcula o limite de R$10 por grupo (cliente + dia + empresa), considerando
      // também eventuais NFs já existentes desses mesmos clientes nesse mesmo dia.
      await recalcularGrupos(
        client,
        calculadas.map((r) => ({ cnpjNorm: r.cnpjNorm, dataEmissao: dataEmissaoFinal, empresaId: empresa.id }))
      );

      await client.query('COMMIT');
      res.redirect(`/upload?ok=1&linhas=${calculadas.length}&lote=${loteId}`);

      // A partir daqui a resposta já foi enviada. O enriquecimento do cadastro de
      // clientes (endereço, código IBGE, regime tributário) continua em segundo
      // plano - pode levar bastante tempo se a fonte estiver com limite de
      // requisições, mas isso nunca deve travar o upload nem fazer a nota falhar.
      if (cnpjsUnicos.length) {
        enriquecerClientesEmSegundoPlano(pool, cnpjsUnicos, `lote ${loteId}`).catch((err) => {
          console.error(`[lote ${loteId}] Erro inesperado no enriquecimento em segundo plano:`, err);
        });
      }
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    render('Ocorreu um erro ao processar a planilha: ' + err.message);
  }
});

module.exports = router;
