const { onlyDigits } = require('./calculo');

const BRASIL_API_BASE = 'https://brasilapi.com.br/api/cnpj/v1';
const OPENCNPJ_BASE = 'https://api.opencnpj.org';
const USER_AGENT = 'Mozilla/5.0 (compatible; ValecareNF/1.0; +https://valecare-nf)';

/**
 * Consulta o CNPJ na BrasilAPI (proxy gratuito e público dos dados da Receita Federal).
 * Não requer chave de API. Lança erro com mensagem amigável em caso de falha.
 */
async function buscarClienteBrasilAPI(cnpjDigits) {
  let resp;
  try {
    resp = await fetch(`${BRASIL_API_BASE}/${cnpjDigits}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
  } catch (err) {
    throw new Error('BrasilAPI: falha de conexão');
  }

  if (resp.status === 404) {
    throw new Error('CNPJ não encontrado na Receita Federal. Confira o número ou preencha os dados manualmente.');
  }
  if (!resp.ok) {
    throw new Error(`BrasilAPI retornou status ${resp.status}`);
  }

  const data = await resp.json();
  // Optante pelo Simples: tem data de opção e não tem data de exclusão registrada
  const optanteSimples = Boolean(data.data_opcao_pelo_simples) && !data.data_exclusao_do_simples;

  return {
    razaoSocial: data.razao_social || '',
    nomeFantasia: data.nome_fantasia || '',
    cidade: data.municipio || '',
    uf: data.uf || '',
    simplesNacional: optanteSimples ? 'Simples Nacional' : 'Não',
    situacaoCadastral: data.descricao_situacao_cadastral || '',
    regimeConhecido: true
  };
}

/**
 * Fallback: OpenCNPJ (fonte alternativa, também gratuita e sem chave). Usada quando
 * a BrasilAPI está indisponível ou bloqueando a requisição. Não confirma o Simples
 * Nacional na mesma resposta, então o regime tributário volta marcado como
 * "a conferir" para o usuário revisar antes de salvar.
 */
async function buscarClienteOpenCNPJ(cnpjDigits) {
  let resp;
  try {
    resp = await fetch(`${OPENCNPJ_BASE}/${cnpjDigits}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
  } catch (err) {
    throw new Error('OpenCNPJ: falha de conexão');
  }

  if (resp.status === 404) {
    throw new Error('CNPJ não encontrado na Receita Federal. Confira o número ou preencha os dados manualmente.');
  }
  if (!resp.ok) {
    throw new Error(`OpenCNPJ retornou status ${resp.status}`);
  }

  const data = await resp.json();

  return {
    razaoSocial: data.razao_social || '',
    nomeFantasia: data.nome_fantasia || '',
    cidade: data.municipio || '',
    uf: data.uf || '',
    simplesNacional: 'Não', // esta fonte não confirma o Simples - revisar manualmente
    situacaoCadastral: data.situacao_cadastral || '',
    regimeConhecido: false
  };
}

async function buscarClienteAPI(cnpjDigits) {
  try {
    return await buscarClienteBrasilAPI(cnpjDigits);
  } catch (err) {
    if (err.message.includes('não encontrado')) throw err; // 404 é definitivo, não tenta fallback
    try {
      return await buscarClienteOpenCNPJ(cnpjDigits);
    } catch (err2) {
      if (err2.message.includes('não encontrado')) throw err2;
      throw new Error('Não foi possível consultar o CNPJ em nenhuma das fontes disponíveis. Tente novamente em instantes ou preencha manualmente.');
    }
  }
}

async function buscarClienteLocal(pool, cnpjDigits) {
  const { rows } = await pool.query('SELECT * FROM clientes WHERE cnpj = $1', [cnpjDigits]);
  return rows[0] || null;
}

async function salvarCliente(pool, cnpjDigits, dados, fonte) {
  const { rows } = await pool.query(
    `INSERT INTO clientes (cnpj, razao_social, nome_fantasia, cidade, uf, simples_nacional, situacao_cadastral, fonte, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (cnpj) DO UPDATE SET
       razao_social = $2, nome_fantasia = $3, cidade = $4, uf = $5,
       simples_nacional = $6, situacao_cadastral = $7, fonte = $8, atualizado_em = now()
     RETURNING *`,
    [
      cnpjDigits,
      dados.razaoSocial || null,
      dados.nomeFantasia || null,
      dados.cidade || null,
      dados.uf || null,
      dados.simplesNacional || null,
      dados.situacaoCadastral || null,
      fonte
    ]
  );
  return rows[0];
}

/**
 * Resolve os dados de um cliente a partir do CNPJ: busca no cadastro local
 * primeiro; se não achar, consulta a BrasilAPI e já grava no cadastro local
 * pra próxima vez ser instantâneo.
 *
 * @returns {{ cnpj: string, razao_social, nome_fantasia, cidade, uf, simples_nacional, fonte: 'cadastro'|'api' }}
 */
async function resolverCliente(pool, cnpjRaw) {
  const cnpj = onlyDigits(cnpjRaw);
  if (cnpj.length !== 14) {
    throw new Error('CNPJ inválido — precisa ter 14 dígitos.');
  }

  const local = await buscarClienteLocal(pool, cnpj);
  if (local) {
    return { ...local, fonte: 'cadastro' };
  }

  const dadosApi = await buscarClienteAPI(cnpj);
  const salvo = await salvarCliente(pool, cnpj, dadosApi, 'api');
  return { ...salvo, fonte: 'api', regimeConhecido: dadosApi.regimeConhecido };
}

module.exports = { resolverCliente, buscarClienteLocal, buscarClienteAPI, salvarCliente };
