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
    .trim()
    .toLowerCase()
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

function parsePlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });

  if (!raw.length) {
    return { rows: [], erros: ['A planilha está vazia.'] };
  }

  // Descobre o mapeamento de colunas a partir do cabeçalho real
  const sampleKeys = Object.keys(raw[0]);
  const colMap = {};
  for (const key of sampleKeys) {
    const norm = normalizeHeader(key);
    if (HEADER_MAP[norm]) colMap[key] = HEADER_MAP[norm];
  }

  const obrigatorias = ['simplesNacional', 'cidade', 'cliente', 'cnpj', 'valor'];
  const encontradas = new Set(Object.values(colMap));
  const faltando = obrigatorias.filter((c) => !encontradas.has(c));
  if (faltando.length) {
    return {
      rows: [],
      erros: [
        `Colunas obrigatórias não encontradas na planilha: ${faltando.join(', ')}. ` +
        `Cabeçalhos esperados: Simples Nacional, Cidade, Cliente, CNPJ, Descrição, Venc., Valor.`
      ]
    };
  }

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
