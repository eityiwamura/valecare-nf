/**
 * Regras de cálculo de impostos - Valecare Medicina e Valecare Engenharia
 *
 * VALECARE MEDICINA
 *  - Se "Simples Nacional" = Simples Nacional -> PIS, COFINS, CSLL = 0, mas IRPJ é
 *    calculado normalmente (sujeito ao limite de R$10, igual aos demais clientes).
 *  - Se "Simples Nacional" = Pessoa Física -> PIS, COFINS, CSLL, IRPJ = 0 (isento total).
 *  - Se "Simples Nacional" = Não:
 *      PIS (0,65%) + COFINS (3%) + CSLL (1%) são calculados juntos e só aparecem na
 *      nota se a SOMA DOS TRÊS para o mesmo cliente (CNPJ) no mesmo lote/dia for
 *      MAIOR que R$10,00. Caso contrário, os três ficam 0 em todas as NFs do grupo.
 *  - IRPJ (1,5%) é calculado para todo cliente que não seja Pessoa Física (inclusive
 *    Simples Nacional) e é avaliado ISOLADAMENTE: só aparece se a soma do IRPJ
 *    (sozinho) para o mesmo cliente no mesmo lote/dia for maior que R$10,00.
 *  - ISS: se Cidade = Taubaté e Valor > R$600 -> ISS = alíquota vigente (input, varia
 *    mês a mês). Se cidade diferente de Taubaté -> ISS = 0. Regra de ISS independe do
 *    Simples Nacional.
 *
 * VALECARE ENGENHARIA
 *  - PIS, COFINS, CSLL, IRPJ = sempre 0
 *  - ISS: mesma regra acima (Taubaté + valor > R$600)
 *
 * Agrupamento "mesmo cliente, mesmo dia": usa o CNPJ normalizado + data de emissão +
 * empresa. Esse agrupamento é aplicado no banco (ver services/grupos.js), não aqui,
 * justamente para que NFs vindas de upload de planilha e NFs lançadas manualmente do
 * mesmo cliente no mesmo dia entrem na mesma soma.
 */

const EMPRESA_MEDICINA = 'medicina';
const EMPRESA_ENGENHARIA = 'engenharia';

const LIMITE_ACUMULO = 10; // R$10,00
const LIMITE_ISS_VALOR = 600; // R$600,00

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function onlyDigits(str) {
  return String(str || '').replace(/\D/g, '');
}

function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

// Valores que costumam indicar "Simples Nacional = sim" em planilhas, além do
// texto completo "Simples Nacional" (ex: coluna preenchida só com "Sim").
const MARCADORES_SIM = new Set(['sim', 's', 'x', '1', 'true', 'verdadeiro']);
const MARCADORES_PESSOA_FISICA = new Set(['pf', 'pessoa fisica']);

// Isento de PIS/COFINS/CSLL: Simples Nacional ou Pessoa Física
function isIsentoTrio(valorCampo) {
  const n = normalizeText(valorCampo);
  if (!n) return false;
  return n.includes('simples') || n.includes('fisica') ||
    MARCADORES_SIM.has(n) || MARCADORES_PESSOA_FISICA.has(n);
}

// Isento de IRPJ: apenas Pessoa Física (Simples Nacional passou a pagar IRPJ)
function isIsentoIrpj(valorCampo) {
  const n = normalizeText(valorCampo);
  if (!n) return false;
  return n.includes('fisica') || MARCADORES_PESSOA_FISICA.has(n);
}

function isTaubate(cidade) {
  return normalizeText(cidade) === 'taubate';
}

/**
 * @param {Object} row - linha crua com os campos:
 *   { simplesNacional, cidade, cliente, cnpj, descricao, vencimento, valor }
 * @param {string} empresaSlug - 'medicina' | 'engenharia'
 * @param {number} issAliquota - percentual de ISS vigente (ex: 2 para 2%)
 * @returns {Object} linha com valores BRUTOS (pré-limite) de pis/cofins/csll/irpj + iss já definitivo
 *
 * O limite de R$10 (por cliente/mesmo dia) NÃO é aplicado aqui — é aplicado depois,
 * em services/grupos.js, consultando o banco. Isso garante que uma NF lançada
 * manualmente e uma NF vinda de planilha, do mesmo cliente no mesmo dia, sejam
 * somadas corretamente mesmo vindo de fluxos diferentes.
 */
function calcularBrutoLinha(row, empresaSlug, issAliquota) {
  const isMedicina = empresaSlug === EMPRESA_MEDICINA;
  const valor = Number(row.valor) || 0;
  const isentoTrio = isIsentoTrio(row.simplesNacional);
  const isentoIrpj = isIsentoIrpj(row.simplesNacional);

  let pisBruto = 0;
  let cofinsBruto = 0;
  let csllBruto = 0;
  let irpjBruto = 0;

  if (isMedicina) {
    if (!isentoTrio) {
      pisBruto = round2(valor * 0.0065);
      cofinsBruto = round2(valor * 0.03);
      csllBruto = round2(valor * 0.01);
    }
    if (!isentoIrpj) {
      irpjBruto = round2(valor * 0.015);
    }
  }

  let iss = 0;
  if (isTaubate(row.cidade) && valor > LIMITE_ISS_VALOR) {
    iss = round2(valor * (Number(issAliquota) || 0) / 100);
  }

  return {
    ...row,
    valor,
    cnpjNorm: onlyDigits(row.cnpj),
    pisBruto,
    cofinsBruto,
    csllBruto,
    irpjBruto,
    iss
  };
}

/**
 * @param {Array} rows - linhas cruas vindas da planilha
 * @param {string} empresaSlug - 'medicina' | 'engenharia'
 * @param {number} issAliquota - percentual de ISS vigente
 * @returns {Array} linhas com valores brutos calculados (ver calcularBrutoLinha)
 */
function calcularLoteBruto(rows, empresaSlug, issAliquota) {
  return rows.map((r) => calcularBrutoLinha(r, empresaSlug, issAliquota));
}

module.exports = {
  calcularBrutoLinha,
  calcularLoteBruto,
  isIsentoTrio,
  isIsentoIrpj,
  isTaubate,
  round2,
  onlyDigits,
  EMPRESA_MEDICINA,
  EMPRESA_ENGENHARIA,
  LIMITE_ACUMULO,
  LIMITE_ISS_VALOR
};
