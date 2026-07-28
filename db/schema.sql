-- Valecare NF - Schema PostgreSQL

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS empresas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(50) UNIQUE NOT NULL,
  slug VARCHAR(50) UNIQUE NOT NULL
);

INSERT INTO empresas (nome, slug) VALUES
  ('Valecare Medicina', 'medicina'),
  ('Valecare Engenharia', 'engenharia')
ON CONFLICT (nome) DO NOTHING;

-- Alíquota de ISS vigente por empresa (varia mês a mês, editável na tela de upload)
CREATE TABLE IF NOT EXISTS configuracoes (
  empresa_id INT PRIMARY KEY REFERENCES empresas(id),
  iss_aliquota NUMERIC(6,3) NOT NULL DEFAULT 2.000,
  updated_at TIMESTAMP DEFAULT now()
);

INSERT INTO configuracoes (empresa_id, iss_aliquota)
  SELECT id, 2.000 FROM empresas
ON CONFLICT (empresa_id) DO NOTHING;

-- Cada upload de planilha gera um "lote" (usado para agrupar NFs do mesmo dia/cliente)
CREATE TABLE IF NOT EXISTS lotes (
  id SERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id),
  arquivo_nome VARCHAR(255),
  iss_aliquota NUMERIC(6,3) NOT NULL,
  data_emissao DATE NOT NULL,
  total_linhas INT DEFAULT 0,
  user_id INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- Cadastro de clientes (alimentado automaticamente via BrasilAPI ou manualmente)
CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  cnpj VARCHAR(14) UNIQUE NOT NULL, -- só dígitos
  razao_social VARCHAR(255),
  nome_fantasia VARCHAR(255),
  logradouro VARCHAR(255),
  numero VARCHAR(20),
  complemento VARCHAR(255),
  bairro VARCHAR(120),
  cep VARCHAR(10),
  codigo_ibge VARCHAR(10),
  cidade VARCHAR(120),
  uf VARCHAR(2),
  simples_nacional VARCHAR(20), -- 'Simples Nacional' | 'Não'
  situacao_cadastral VARCHAR(50),
  fonte VARCHAR(10) DEFAULT 'api', -- 'api' | 'manual'
  atualizado_em TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now()
);

-- Colunas de endereço em bancos já existentes (idempotente)
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS logradouro VARCHAR(255);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS numero VARCHAR(20);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS complemento VARCHAR(255);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bairro VARCHAR(120);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS cep VARCHAR(10);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_ibge VARCHAR(10);

CREATE TABLE IF NOT EXISTS notas_fiscais (
  id SERIAL PRIMARY KEY,
  lote_id INT REFERENCES lotes(id) ON DELETE CASCADE,
  empresa_id INT NOT NULL REFERENCES empresas(id),
  simples_nacional VARCHAR(50),
  cidade VARCHAR(120),
  cliente VARCHAR(255),
  cnpj VARCHAR(30),
  cnpj_norm VARCHAR(14), -- CNPJ só com dígitos, usado para agrupar por cliente
  codigo_servico VARCHAR(20),
  nbs VARCHAR(20),
  indicador_operacao VARCHAR(20),
  classificacao_tributaria VARCHAR(20),
  descricao VARCHAR(255),
  vencimento DATE,
  data_emissao DATE NOT NULL,
  origem VARCHAR(10) NOT NULL DEFAULT 'upload', -- 'upload' | 'manual'
  valor NUMERIC(14,2) NOT NULL DEFAULT 0,
  pis_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  cofins_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  csll_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  irpj_bruto NUMERIC(14,2) NOT NULL DEFAULT 0,
  pis NUMERIC(14,2) NOT NULL DEFAULT 0,
  cofins NUMERIC(14,2) NOT NULL DEFAULT 0,
  csll NUMERIC(14,2) NOT NULL DEFAULT 0,
  irpj NUMERIC(14,2) NOT NULL DEFAULT 0,
  iss NUMERIC(14,2) NOT NULL DEFAULT 0,
  valor_liquido NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);

-- Colunas novas em bancos já existentes (idempotente - não quebra deploys anteriores)
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS cnpj_norm VARCHAR(14);
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS codigo_servico VARCHAR(20);
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS nbs VARCHAR(20);
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS indicador_operacao VARCHAR(20);
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS classificacao_tributaria VARCHAR(20);
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS origem VARCHAR(10) NOT NULL DEFAULT 'upload';
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS pis_bruto NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS cofins_bruto NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS csll_bruto NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE notas_fiscais ADD COLUMN IF NOT EXISTS irpj_bruto NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Preenche cnpj_norm para linhas já existentes (bancos que já tinham notas antes desta versão)
UPDATE notas_fiscais SET cnpj_norm = regexp_replace(cnpj, '\D', '', 'g')
  WHERE cnpj_norm IS NULL OR cnpj_norm = '';

CREATE INDEX IF NOT EXISTS idx_nf_empresa ON notas_fiscais(empresa_id);
CREATE INDEX IF NOT EXISTS idx_nf_cliente ON notas_fiscais(cliente);
CREATE INDEX IF NOT EXISTS idx_nf_cidade ON notas_fiscais(cidade);
CREATE INDEX IF NOT EXISTS idx_nf_vencimento ON notas_fiscais(vencimento);
CREATE INDEX IF NOT EXISTS idx_nf_data_emissao ON notas_fiscais(data_emissao);
CREATE INDEX IF NOT EXISTS idx_nf_cnpj ON notas_fiscais(cnpj);
CREATE INDEX IF NOT EXISTS idx_nf_grupo ON notas_fiscais(cnpj_norm, data_emissao, empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_cnpj ON clientes(cnpj);

-- Cadastro de códigos de serviço (NFS-e) por empresa, usado no lançamento manual
CREATE TABLE IF NOT EXISTS codigos_servico (
  id SERIAL PRIMARY KEY,
  empresa_id INT NOT NULL REFERENCES empresas(id),
  codigo VARCHAR(20) NOT NULL,
  descricao VARCHAR(255),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(empresa_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_codigos_servico_empresa ON codigos_servico(empresa_id);

-- Hierarquia em cascata: Código de Serviço > NBS > Indicador de Operação > Classificação Tributária
CREATE TABLE IF NOT EXISTS nbs (
  id SERIAL PRIMARY KEY,
  codigo_servico_id INT NOT NULL REFERENCES codigos_servico(id) ON DELETE CASCADE,
  codigo VARCHAR(20) NOT NULL,
  descricao VARCHAR(255),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(codigo_servico_id, codigo)
);

CREATE TABLE IF NOT EXISTS indicadores_operacao (
  id SERIAL PRIMARY KEY,
  nbs_id INT NOT NULL REFERENCES nbs(id) ON DELETE CASCADE,
  codigo VARCHAR(20) NOT NULL,
  descricao VARCHAR(255),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(nbs_id, codigo)
);

CREATE TABLE IF NOT EXISTS classificacoes_tributarias (
  id SERIAL PRIMARY KEY,
  indicador_operacao_id INT NOT NULL REFERENCES indicadores_operacao(id) ON DELETE CASCADE,
  codigo VARCHAR(20) NOT NULL,
  descricao VARCHAR(255),
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(indicador_operacao_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_nbs_codigo_servico ON nbs(codigo_servico_id);
CREATE INDEX IF NOT EXISTS idx_indicadores_nbs ON indicadores_operacao(nbs_id);
CREATE INDEX IF NOT EXISTS idx_classificacoes_indicador ON classificacoes_tributarias(indicador_operacao_id);

-- Sessões (connect-pg-simple cria a tabela automaticamente, mantido aqui como referência)
