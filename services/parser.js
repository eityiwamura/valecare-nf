const XLSX = require('xlsx');

// Mapeamento flexível de cabeçalhos (aceita variações de acentuação/espaço)
const HEADER_MAP = {
  'simples nacional': 'simplesNacional',
  'cidade': 'cidade',
  'cliente': 'cliente',
  'cnpj': 'cnpj',
  'descricao': 'descricao',
  'descrição': 'descricao',
  'venc': 'vencimento',
  'venc.': 'vencimento',
  'vencimento': 'vencimento',
  'valor': 'valor'
};

function normalizeHeader(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/r\$/g, '')       // remove marcador de moeda "R$" (ex: "Valor(R$)")
    .replace(/[()]/g, '')      // remove parênteses
    .trim()
    .replace(/\s+/g, ' ')      // colapsa espaços múltiplos
    .replace(/\.$/, '');
}


function excelDateToJSDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Serial date do Excel (base 1900)
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  }
  if (typeof value === 'string') {
    const s = value.trim();
    const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (br) return new Date(Date.UTC(+br[3], +br[2] - 1, +br[1]));
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
  }
  return null;
}

function toISODate(d) {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Monta o mapeamento coluna-original -> campo-de-destino para uma lista de
 * cabeçalhos, e diz quantos dos campos obrigatórios ela cobre. Usado para
 * escolher, entre várias abas do arquivo, qual delas é a planilha de dados
 * (e não, por exemplo, uma aba de "Cadastro de Clientes").
 */
function mapearColunas(headers) {
  const colMap = {};
  const jaMapeado = new Set();

  for (const key of headers) {
    const norm = normalizeHeader(key);
    if (HEADER_MAP[norm]) {
      colMap[key] = HEADER_MAP[norm];
      jaMapeado.add(HEADER_MAP[norm]);
    }
  }
  for (const key of headers) {
    if (colMap[key]) continue;
    const norm = normalizeHeader(key);
    if (norm.startsWith('cnpj') && !jaMapeado.has('cnpj')) {
      colMap[key] = 'cnpj';
      jaMapeado.add('cnpj');
    } else if (norm.startsWith('valor') && !jaMapeado.has('valor') &&
      !norm.includes('liquido') && !norm.includes('recebido') && !norm.includes('deducao')) {
      colMap[key] = 'valor';
      jaMapeado.add('valor');
    }
  }
  return colMap;
}

function obrigatoriasPara(empresaSlug) {
  return empresaSlug === 'engenharia'
    ? ['cidade', 'cliente', 'cnpj', 'valor']
    : ['simplesNacional', 'cidade', 'cliente', 'cnpj', 'valor'];
}

function parsePlanilha(buffer, empresaSlug) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const obrigatorias = obrigatoriasPara(empresaSlug);

  if (!wb.SheetNames.length) {
    return { rows: [], erros: ['Não foi possível ler nenhuma aba deste arquivo.'] };
  }

  // O arquivo pode ter mais de uma aba (ex: "Cadastro Clientes" + "Mensal - Julho").
  // Escolhe automaticamente a aba que tem os campos obrigatórios (a planilha de
  // dados de fato), em vez de assumir que é sempre a primeira aba do arquivo.
  let melhor = null; // { sheetName, raw, colMap, faltando }

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    if (!raw.length) continue;

    const colMap = mapearColunas(Object.keys(raw[0]));
    const encontradas = new Set(Object.values(colMap));
    const faltando = obrigatorias.filter((c) => !encontradas.has(c));

    if (!faltando.length) {
      melhor = { sheetName, raw, colMap, faltando };
      break; // achou uma aba que serve, não precisa olhar as outras
    }
    // guarda a que chegou mais perto (menos campos faltando) para a mensagem de erro
    if (!melhor || faltando.length < melhor.faltando.length) {
      melhor = { sheetName, raw, colMap, faltando };
    }
  }

  if (!melhor) {
    return { rows: [], erros: ['Todas as abas do arquivo estão vazias.'] };
  }

  if (melhor.faltando.length) {
    return {
      rows: [],
      erros: [
        `Colunas obrigatórias não encontradas na aba "${melhor.sheetName}": ${melhor.faltando.join(', ')}. ` +
        `Cabeçalhos esperados: ${empresaSlug === 'engenharia' ? 'Cidade, Cliente, CNPJ, Descrição, Venc., Valor' : 'Simples Nacional, Cidade, Cliente, CNPJ, Descrição, Venc., Valor'}.` +
        (wb.SheetNames.length > 1 ? ` (o arquivo tem ${wb.SheetNames.length} abas: ${wb.SheetNames.join(', ')} — nenhuma delas tem todas as colunas necessárias)` : '')
      ]
    };
  }

  const { raw, colMap } = melhor;
  const rows = [];
  const erros = [];

  raw.forEach((linha, idx) => {
    const row = {};
    for (const [origKey, destKey] of Object.entries(colMap)) {
      row[destKey] = linha[origKey];
    }

    // Ignora linhas totalmente vazias
    const vazia = !row.cliente && !row.cnpj && !row.valor;
    if (vazia) return;

    const valorNum = parseValor(row.valor);

    const vencDate = excelDateToJSDate(row.vencimento);

    if (!row.cliente || !row.cnpj) {
      erros.push(`Linha ${idx + 2}: cliente ou CNPJ ausente — linha ignorada.`);
      return;
    }

    // Ignora linhas de rodapé/resumo (ex: "SUBTOTAL", "TOTAL") que às vezes
    // aparecem no fim da planilha e não são NFs de verdade.
    const clienteNorm = String(row.cliente).trim().toLowerCase();
    if (clienteNorm === 'subtotal' || clienteNorm === 'total' || clienteNorm === 'totais') {
      return;
    }

    rows.push({
      simplesNacional: String(row.simplesNacional || '').trim(),
      cidade: String(row.cidade || '').trim(),
      cliente: String(row.cliente || '').trim(),
      cnpj: String(row.cnpj || '').trim(),
      descricao: String(row.descricao || '').trim(),
      vencimento: toISODate(vencDate),
      valor: round(valorNum)
    });
  });

  return { rows, erros };
}

function parseValor(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined || v === '') return 0;
  let s = String(v).trim().replace(/[^\d,.-]/g, '');
  // Formato BR "1.234,56" -> remove separador de milhar, vírgula vira ponto
  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, '').replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { parsePlanilha };
