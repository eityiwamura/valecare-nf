const { onlyDigits } = require('./calculo');

const BRASIL_API_BASE = 'https://brasilapi.com.br/api/cnpj/v1';
const OPENCNPJ_BASE = 'https://api.opencnpj.org';
const IBGE_MUNICIPIOS_BASE = 'https://servicodados.ibge.gov.br/api/v1/localidades/estados';
const USER_AGENT = 'Mozilla/5.0 (compatible; ValecareNF/1.0; +https://valecare-nf)';

function normalizarNomeMunicipio(nome) {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Resolve o código IBGE (7 dígitos) de um município a partir do nome + UF,
 * usando a API oficial e gratuita do IBGE (servicodados.ibge.gov.br). Usada
 * como complemento quando a fonte de CNPJ não devolve o código IBGE direto
 * (caso do fallback OpenCNPJ).
 */
async function buscarCodigoIbgePorNomeUf(municipio, uf) {
  if (!municipio || !uf) return '';
  try {
    const resp = await fetch(`${IBGE_MUNICIPIOS_BASE}/${uf}/municipios`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    if (!resp.ok) return '';
    const lista = await resp.json();
    const alvo = normalizarNomeMunicipio(municipio);
    const encontrado = lista.find((m) => normalizarNomeMunicipio(m.nome) === alvo);
    return encontrado ? String(encontrado.id) : '';
  } catch (err) {
    return ''; // não bloqueia a busca do cliente por causa disso
  }
}

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
    logradouro: data.logradouro || '',
    numero: data.numero || '',
    complemento: data.complemento || '',
    bairro: data.bairro || '',
    cep: data.cep || '',
    cidade: data.municipio || '',
    uf: data.uf || '',
    codigoIbge: data.codigo_municipio_ibge ? String(data.codigo_municipio_ibge) : '',
    simplesNacional: optanteSimples ? 'Simples Nacional' : 'Não',
    situacaoCadastral: data.descricao_situacao_cadastral || '',
    regimeConhecido: true
  };
}

/**
 * Fallback: OpenCNPJ (fonte alternativa, também gratuita e sem chave). Usada quando
 * a BrasilAPI está indisponível ou bloqueando a requisição. Não confirma o Simples
 * Nacional nem o código IBGE na mesma resposta — o Simples volta marcado como
 * "a conferir" e o código IBGE é resolvido à parte via API oficial do IBGE.
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
  const codigoIbge = await buscarCodigoIbgePorNomeUf(data.municipio, data.uf);

  return {
    razaoSocial: data.razao_social || '',
    nomeFantasia: data.nome_fantasia || '',
    logradouro: data.logradouro || '',
    numero: data.numero || '',
    complemento: data.complemento || '',
    bairro: data.bairro || '',
    cep: data.cep || '',
    cidade: data.municipio || '',
    uf: data.uf || '',
    codigoIbge,
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
    `INSERT INTO clientes (cnpj, razao_social, nome_fantasia, logradouro, numero, complemento, bairro, cep, codigo_ibge, cidade, uf, simples_nacional, situacao_cadastral, fonte, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
     ON CONFLICT (cnpj) DO UPDATE SET
       razao_social = $2, nome_fantasia = $3, logradouro = $4, numero = $5, complemento = $6,
       bairro = $7, cep = $8, codigo_ibge = $9, cidade = $10, uf = $11, simples_nacional = $12, situacao_cadastral = $13,
       fonte = $14, atualizado_em = now()
     RETURNING *`,
    [
      cnpjDigits,
      dados.razaoSocial || null,
      dados.nomeFantasia || null,
      dados.logradouro || null,
      dados.numero || null,
      dados.complemento || null,
      dados.bairro || null,
      dados.cep || null,
      dados.codigoIbge || null,
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
  if (local && local.codigo_ibge) {
    return { ...local, fonte: 'cadastro' };
  }

  // Cliente novo, ou já cadastrado antes do código IBGE existir no sistema -> (re)consulta
  const dadosApi = await buscarClienteAPI(cnpj);
  const salvo = await salvarCliente(pool, cnpj, dadosApi, 'api');
  return { ...salvo, fonte: local ? 'cadastro' : 'api', regimeConhecido: dadosApi.regimeConhecido };
}

module.exports = { resolverCliente, buscarClienteLocal, buscarClienteAPI, salvarCliente };
