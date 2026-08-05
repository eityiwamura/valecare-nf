const XLSX = require('xlsx');

// Ordem exata das colunas conforme o modelo fornecido (NF_30.xlsx)
const COLUNAS_BASE = [
  'CPF_CNPJ', 'Nome', 'Valor', 'Codigo_Servico', 'Endereco_Pais', 'Endereco_Cep',
  'Endereco_Logradouro', 'Endereco_Numero', 'Endereco_Complemento', 'Endereco_Bairro',
  'Endereco_Cidade_Codigo', 'Endereco_Cidade_Nome', 'Endereco_Estado', 'Descricao',
  'IBSCBS_Indicador_Operacao', 'IBSCBS_Codigo_Classificacao', 'NBS', 'Tipo_Tributacao',
  'Aliquota_ISS', 'Valor_ISS'
];

const COLUNAS_MEDICINA = [
  ...COLUNAS_BASE,
  'Retencao_IR', 'Retencao_PIS', 'Retencao_COFINS', 'Retencao_CSLL', 'Retencao_INSS',
  'Retencao_ISS', 'Retencao_OUTROS', 'Valor_Deducoes', 'Valor_Recebido'
];

const COLUNAS_ENGENHARIA = [
  ...COLUNAS_BASE,
  'Retencao_ISS', 'Retencao_OUTROS', 'Valor_Deducoes', 'Valor_Recebido'
];

/**
 * Converte para número quando o valor "parece" um número (mantendo o padrão do
 * modelo para colunas de endereço: número da casa, código IBGE etc. são gravados
 * como número no modelo original).
 */
function comoNumeroOuTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  const n = Number(valor);
  return Number.isFinite(n) ? n : String(valor);
}

/**
 * Mantém sempre como TEXTO, mesmo que pareça um número — usado nos campos onde
 * perder o zero à esquerda (ex: "040301" virar 40301) quebra a leitura da
 * planilha por outros sistemas: CPF_CNPJ, Codigo_Servico, indicador de operação
 * e classificação tributária.
 */
function comoTexto(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  return String(valor);
}

function valorOuVazio(n) {
  const num = Number(n);
  return num && num !== 0 ? num : '';
}

/**
 * Igual a valorOuVazio, mas nunca deixa em branco: quando o valor é zero/vazio,
 * retorna 0 em vez de ''. Usado nas colunas de retenção da Valecare Medicina,
 * a pedido do usuário (o sistema que recebe a planilha não deve receber células
 * vazias nesses campos específicos).
 */
function valorOuZero(n) {
  const num = Number(n);
  return Number.isFinite(num) ? num : 0;
}

/**
 * Monta a linha de exportação de uma NF no formato do modelo.
 * @param {Object} nf - linha vinda da query (join notas_fiscais + clientes)
 */
function montarLinha(nf, isMedicina) {
  const base = {
    CPF_CNPJ: comoTexto(nf.cnpj_norm || nf.cnpj),
    Nome: nf.cliente || '',
    Valor: Number(nf.valor) || 0,
    Codigo_Servico: comoTexto(nf.codigo_servico),
    Endereco_Pais: 'BRA',
    Endereco_Cep: nf.cliente_cep || '',
    Endereco_Logradouro: nf.cliente_logradouro || '',
    Endereco_Numero: comoNumeroOuTexto(nf.cliente_numero),
    Endereco_Complemento: nf.cliente_complemento || '',
    Endereco_Bairro: nf.cliente_bairro || '',
    Endereco_Cidade_Codigo: comoNumeroOuTexto(nf.cliente_codigo_ibge),
    Endereco_Cidade_Nome: nf.cidade || nf.cliente_cidade || '',
    Endereco_Estado: nf.cliente_uf || '',
    Descricao: nf.descricao || '',
    IBSCBS_Indicador_Operacao: comoTexto(nf.indicador_operacao),
    IBSCBS_Codigo_Classificacao: comoTexto(nf.classificacao_tributaria),
    NBS: nf.nbs || '',
    Tipo_Tributacao: '',
    Aliquota_ISS: '',
    Valor_ISS: ''
  };

  if (isMedicina) {
    return {
      ...base,
      Retencao_IR: valorOuVazio(nf.irpj),
      Retencao_PIS: valorOuZero(nf.pis),
      Retencao_COFINS: valorOuZero(nf.cofins),
      Retencao_CSLL: valorOuZero(nf.csll),
      Retencao_INSS: 0,
      Retencao_ISS: valorOuZero(nf.iss),
      Retencao_OUTROS: 0,
      Valor_Deducoes: '',
      Valor_Recebido: ''
    };
  }

  return {
    ...base,
    Retencao_ISS: valorOuVazio(nf.iss),
    Retencao_OUTROS: '',
    Valor_Deducoes: '',
    Valor_Recebido: ''
  };
}

function normalizarSlug(v) {
  return String(v || '').trim().toLowerCase();
}

/**
 * Gera o buffer .xlsx com as NFs selecionadas, separadas em abas MEDICINA/ENGENHARIA,
 * no mesmo formato do modelo NF_30.xlsx.
 * @param {Array} notas - linhas do join notas_fiscais + empresas + clientes
 * @returns {Buffer}
 */
function gerarExportacao(notas) {
  const medicina = notas.filter((n) => normalizarSlug(n.empresa_slug) === 'medicina').map((n) => montarLinha(n, true));
  const engenharia = notas.filter((n) => normalizarSlug(n.empresa_slug) === 'engenharia').map((n) => montarLinha(n, false));

  const semEmpresaReconhecida = notas.filter((n) => !['medicina', 'engenharia'].includes(normalizarSlug(n.empresa_slug)));
  if (semEmpresaReconhecida.length) {
    console.warn(
      `Exportação: ${semEmpresaReconhecida.length} nota(s) com empresa não reconhecida (slug inesperado) e por isso não entraram em nenhuma aba:`,
      semEmpresaReconhecida.map((n) => ({ id: n.id, empresa_slug: n.empresa_slug }))
    );
  }

  const wb = XLSX.utils.book_new();

  const sheetMedicina = XLSX.utils.json_to_sheet(medicina, { header: COLUNAS_MEDICINA });
  XLSX.utils.book_append_sheet(wb, sheetMedicina, 'MEDICINA');

  const sheetEngenharia = XLSX.utils.json_to_sheet(engenharia, { header: COLUNAS_ENGENHARIA });
  XLSX.utils.book_append_sheet(wb, sheetEngenharia, 'ENGENHARIA');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { gerarExportacao, COLUNAS_MEDICINA, COLUNAS_ENGENHARIA };
