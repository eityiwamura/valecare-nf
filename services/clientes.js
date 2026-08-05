const { onlyDigits, calcularBrutoLinha } = require('./calculo');
const { recalcularGrupo } = require('./grupos');

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

const VIACEP_BASE = 'https://viacep.com.br/ws';
const BRASILAPI_CEP_BASE = 'https://brasilapi.com.br/api/cep/v2';

/**
 * Busca endereço completo (incluindo código IBGE) a partir de um CEP.
 * Usada principalmente pra clientes CPF, onde não existe consulta por
 * documento — o CEP é o jeito de completar o endereço automaticamente.
 * Também útil pra corrigir/completar o endereço de um CNPJ já cadastrado.
 */
async function buscarEnderecoPorCep(cepRaw) {
  const cep = String(cepRaw || '').replace(/\D/g, '');
  if (cep.length !== 8) {
    throw new Error('CEP inválido — precisa ter 8 dígitos.');
  }

  // Fonte principal: ViaCEP
  try {
    const resp = await fetch(`${VIACEP_BASE}/${cep}/json/`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (!data.erro) {
        return {
          logradouro: data.logradouro || '',
          bairro: data.bairro || '',
          cidade: data.localidade || '',
          uf: data.uf || '',
          codigoIbge: data.ibge || ''
        };
      }
    }
  } catch (err) {
    // segue para o fallback
  }

  // Fallback: BrasilAPI (não devolve código IBGE direto - resolve à parte pelo nome da cidade)
  try {
    const resp = await fetch(`${BRASILAPI_CEP_BASE}/${cep}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
    if (resp.ok) {
      const data = await resp.json();
      const codigoIbge = await buscarCodigoIbgePorNomeUf(data.city, data.state);
      return {
        logradouro: data.street || '',
        bairro: data.neighborhood || '',
        cidade: data.city || '',
        uf: data.state || '',
        codigoIbge
      };
    }
  } catch (err) {
    // segue para o erro final
  }

  throw new Error('CEP não encontrado em nenhuma fonte. Confira o número ou preencha o endereço manualmente.');
}

function esperar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Espera crescente entre tentativas (1.5s, 3s, 6s, 12s, 20s, 20s, 20s...),
 * usada tanto na BrasilAPI quanto no fallback OpenCNPJ - o objetivo é nunca
 * desistir por causa de limite de requisições, só por CNPJ realmente
 * inexistente (404) ou depois de esgotar bastante tempo de tentativas.
 */
function esperaCrescente(tentativa) {
  return Math.min(1500 * Math.pow(2, tentativa - 1), 20000);
}

/**
 * Consulta o CNPJ na BrasilAPI (proxy gratuito e público dos dados da Receita Federal).
 * Não requer chave de API. Em caso de limite de requisições (429) ou bloqueio
 * temporário (403), espera cada vez mais e tenta de novo — essa consulta não pode
 * falhar por limite de requisições, só desiste depois de várias tentativas.
 */
async function buscarClienteBrasilAPI(cnpjDigits, tentativa) {
  tentativa = tentativa || 1;
  const MAX_TENTATIVAS = 6;
  let resp;
  try {
    resp = await fetch(`${BRASIL_API_BASE}/${cnpjDigits}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
  } catch (err) {
    if (tentativa < MAX_TENTATIVAS) {
      await esperar(esperaCrescente(tentativa));
      return buscarClienteBrasilAPI(cnpjDigits, tentativa + 1);
    }
    throw new Error('BrasilAPI: falha de conexão');
  }

  if (resp.status === 404) {
    throw new Error('CNPJ não encontrado na Receita Federal. Confira o número ou preencha os dados manualmente.');
  }
  if ((resp.status === 429 || resp.status === 403 || resp.status >= 500) && tentativa < MAX_TENTATIVAS) {
    await esperar(esperaCrescente(tentativa));
    return buscarClienteBrasilAPI(cnpjDigits, tentativa + 1);
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
 * a BrasilAPI está indisponível ou bloqueando a requisição. Também tenta várias
 * vezes com espera crescente antes de desistir. Não confirma o Simples Nacional
 * na mesma resposta — o Simples volta em branco ("a confirmar") e o código IBGE
 * é resolvido à parte via API oficial do IBGE.
 */
async function buscarClienteOpenCNPJ(cnpjDigits, tentativa) {
  tentativa = tentativa || 1;
  const MAX_TENTATIVAS = 5;
  let resp;
  try {
    resp = await fetch(`${OPENCNPJ_BASE}/${cnpjDigits}`, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }
    });
  } catch (err) {
    if (tentativa < MAX_TENTATIVAS) {
      await esperar(esperaCrescente(tentativa));
      return buscarClienteOpenCNPJ(cnpjDigits, tentativa + 1);
    }
    throw new Error('OpenCNPJ: falha de conexão');
  }

  if (resp.status === 404) {
    throw new Error('CNPJ não encontrado na Receita Federal. Confira o número ou preencha os dados manualmente.');
  }
  if ((resp.status === 429 || resp.status === 403 || resp.status >= 500) && tentativa < MAX_TENTATIVAS) {
    await esperar(esperaCrescente(tentativa));
    return buscarClienteOpenCNPJ(cnpjDigits, tentativa + 1);
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
    simplesNacional: '', // esta fonte não confirma o Simples - fica em branco para revisão manual (nunca assume "Não")
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

      // As duas fontes já tentaram várias vezes e falharam. Como essa consulta não
      // pode falhar por causa de limite de requisições, dá mais uma rodada de
      // resgate depois de um respiro maior, antes de desistir de vez.
      await esperar(30000);
      try {
        return await buscarClienteBrasilAPI(cnpjDigits);
      } catch (err3) {
        if (err3.message.includes('não encontrado')) throw err3;
        try {
          return await buscarClienteOpenCNPJ(cnpjDigits);
        } catch (err4) {
          if (err4.message.includes('não encontrado')) throw err4;
          throw new Error('Não foi possível consultar o CNPJ em nenhuma das fontes disponíveis, mesmo após várias tentativas. Tente novamente mais tarde ou preencha manualmente.');
        }
      }
    }
  }
}

async function buscarClienteLocal(pool, documentoDigits) {
  const { rows } = await pool.query('SELECT * FROM clientes WHERE cnpj = $1', [documentoDigits]);
  return rows[0] || null;
}

async function salvarCliente(pool, documentoDigits, dados, fonte, tipoDocumento) {
  const tipo = tipoDocumento || (documentoDigits.length === 11 ? 'cpf' : 'cnpj');
  const { rows } = await pool.query(
    `INSERT INTO clientes (cnpj, tipo_documento, razao_social, nome_fantasia, logradouro, numero, complemento, bairro, cep, codigo_ibge, cidade, uf, simples_nacional, situacao_cadastral, fonte, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
     ON CONFLICT (cnpj) DO UPDATE SET
       tipo_documento = $2, razao_social = $3, nome_fantasia = $4, logradouro = $5, numero = $6, complemento = $7,
       bairro = $8, cep = $9, codigo_ibge = $10, cidade = $11, uf = $12, simples_nacional = $13, situacao_cadastral = $14,
       fonte = $15, atualizado_em = now()
     RETURNING *`,
    [
      documentoDigits,
      tipo,
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
 * Salva os dados de um cliente (CNPJ ou CPF) a partir de campos digitados num
 * formulário, mesclando com o que já existir no cadastro local (um campo em
 * branco no formulário não apaga um valor já salvo antes - só sobrescreve
 * quando o usuário realmente preencheu algo novo).
 */
async function salvarClienteFormulario(pool, documentoDigits, tipoDocumento, campos, fonte) {
  const local = await buscarClienteLocal(pool, documentoDigits);
  const dados = {
    razaoSocial: campos.razaoSocial || local?.razao_social || '',
    logradouro: campos.logradouro || local?.logradouro || '',
    numero: campos.numero || local?.numero || '',
    complemento: campos.complemento || local?.complemento || '',
    bairro: campos.bairro || local?.bairro || '',
    cep: campos.cep || local?.cep || '',
    codigoIbge: campos.codigoIbge || local?.codigo_ibge || '',
    cidade: campos.cidade || local?.cidade || '',
    uf: campos.uf || local?.uf || '',
    simplesNacional: campos.simplesNacional || local?.simples_nacional || '',
    situacaoCadastral: local?.situacao_cadastral || ''
  };
  return salvarCliente(pool, documentoDigits, dados, fonte, tipoDocumento);
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
  if (local && local.codigo_ibge && local.simples_nacional && local.cidade) {
    return { ...local, fonte: 'cadastro' };
  }

  // Cliente novo, ou já cadastrado com dado incompleto (sem código IBGE, sem
  // cidade, ou sem confirmar o regime tributário) -> tenta consultar de novo,
  // dando outra chance de vir da BrasilAPI (que confirma o Simples) em vez do fallback.
  const dadosApi = await buscarClienteAPI(cnpj);
  const salvo = await salvarCliente(pool, cnpj, dadosApi, 'api', 'cnpj');
  return { ...salvo, fonte: local ? 'cadastro' : 'api', regimeConhecido: dadosApi.regimeConhecido };
}

/**
 * Busca genérica usada pela tela de lançamento manual: aceita CPF (11 dígitos)
 * ou CNPJ (14 dígitos). Para CPF, só existe busca no cadastro LOCAL — não há
 * API pública/gratuita e legal para consulta de dados pessoais por CPF no
 * Brasil, então um CPF só é encontrado se já tiver sido salvo antes pelo
 * próprio sistema (numa NF manual anterior).
 */
async function buscarClienteGenerico(pool, documentoRaw) {
  const digits = onlyDigits(documentoRaw);

  if (digits.length === 11) {
    const local = await buscarClienteLocal(pool, digits);
    if (local) return { ...local, fonte: 'cadastro' };
    const err = new Error('Este CPF ainda não está no cadastro. Preencha os dados manualmente — serão salvos automaticamente ao salvar a NF.');
    err.cpfNaoEncontrado = true;
    throw err;
  }

  if (digits.length === 14) {
    return resolverCliente(pool, digits);
  }

  throw new Error('Documento inválido — informe um CPF (11 dígitos) ou CNPJ (14 dígitos).');
}

/**
 * Depois de confirmar os dados de um CNPJ na Receita Federal, atualiza as NFs
 * desse lote que usam esse CNPJ: aplica o regime tributário confirmado (sempre,
 * mesmo comportamento do lançamento manual) e preenche a cidade quando a NF
 * não trouxe uma da planilha (sem sobrescrever uma cidade que o usuário já
 * informou explicitamente) - e recalcula os impostos (incluindo ISS) depois
 * disso. É isso que faz o upload em lote se comportar igual ao lançamento
 * manual, onde esses dados sempre vêm da consulta à Receita.
 */
async function sincronizarNfsDoLote(pool, { loteId, cnpjNorm, empresaId, empresaSlug, dataEmissao, issAliquota, regimeConfirmado, cidadeConfirmada }) {
  const { rows: nfs } = await pool.query(
    'SELECT * FROM notas_fiscais WHERE lote_id = $1 AND cnpj_norm = $2',
    [loteId, cnpjNorm]
  );
  if (!nfs.length) return;

  for (const nf of nfs) {
    const regimeFinal = regimeConfirmado || nf.simples_nacional;
    const cidadeFinal = nf.cidade || cidadeConfirmada || '';

    if (regimeFinal === nf.simples_nacional && cidadeFinal === nf.cidade) continue; // nada mudou, não recalcula à toa

    const linha = {
      simplesNacional: regimeFinal,
      cidade: cidadeFinal,
      cliente: nf.cliente,
      cnpj: nf.cnpj,
      descricao: nf.descricao,
      valor: Number(nf.valor)
    };
    const bruto = calcularBrutoLinha(linha, empresaSlug, issAliquota);
    await pool.query(
      `UPDATE notas_fiscais SET simples_nacional = $1, cidade = $2, pis_bruto = $3, cofins_bruto = $4,
        csll_bruto = $5, irpj_bruto = $6, iss = $7
       WHERE id = $8`,
      [regimeFinal, cidadeFinal, bruto.pisBruto, bruto.cofinsBruto, bruto.csllBruto, bruto.irpjBruto, bruto.iss, nf.id]
    );
  }

  await recalcularGrupo(pool, { cnpjNorm, dataEmissao, empresaId });
}

/**
 * Roda em segundo plano depois de um upload: para cada CNPJ único do lote,
 * confirma o cadastro (endereço + regime tributário) na Receita Federal e, assim
 * que confirmado, corrige e recalcula as NFs desse lote que usam esse CNPJ - sem
 * prender a resposta HTTP do upload, e sem desistir por causa de limite de
 * requisições (cada consulta já tenta várias vezes sozinha).
 */
async function processarLoteEmSegundoPlano(pool, { loteId, empresaId, empresaSlug, dataEmissao, issAliquota, cnpjsUnicos }, contexto) {
  const rotulo = contexto || `lote ${loteId}`;
  let ok = 0;
  let falhas = 0;
  let corrigidos = 0;
  for (const cnpj of cnpjsUnicos) {
    try {
      const resolvido = await resolverCliente(pool, cnpj);
      if (resolvido.simples_nacional || resolvido.cidade) {
        await sincronizarNfsDoLote(pool, {
          loteId, cnpjNorm: cnpj, empresaId, empresaSlug, dataEmissao, issAliquota,
          regimeConfirmado: resolvido.simples_nacional,
          cidadeConfirmada: resolvido.cidade
        });
        corrigidos++;
      }
      ok++;
    } catch (err) {
      falhas++;
      console.warn(`[${rotulo}] Não foi possível enriquecer/confirmar o CNPJ ${cnpj}: ${err.message}`);
    }
    await esperar(500); // respiro entre CNPJs, além da espera crescente já embutida em cada consulta
  }
  console.log(`[${rotulo}] Processamento em segundo plano concluído: ${ok} ok, ${falhas} falha(s) de ${cnpjsUnicos.length}, ${corrigidos} CNPJ(s) com regime e/ou cidade aplicados às NFs.`);
}

module.exports = {
  resolverCliente,
  buscarClienteGenerico,
  buscarClienteLocal,
  buscarClienteAPI,
  buscarEnderecoPorCep,
  salvarCliente,
  salvarClienteFormulario,
  processarLoteEmSegundoPlano
};
