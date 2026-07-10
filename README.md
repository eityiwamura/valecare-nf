# Valecare NF

Sistema web para calcular automaticamente os impostos (PIS, COFINS, CSLL, IRPJ, ISS) de
cada Nota Fiscal da **Valecare Medicina** e **Valecare Engenharia**, a partir de uma
planilha mensal. Mantém histórico com filtros/paginação/ordenação e um dashboard com o
total emitido e o total de impostos pagos.

Stack: Node.js + Express + PostgreSQL + EJS (mesmo padrão do Agrovale NF Validator e do
PontoApp), pronto para deploy via Docker no EasyPanel.

## Regras de cálculo implementadas

**Valecare Medicina**
- Cliente do **Simples Nacional** → PIS, COFINS e CSLL = 0. **IRPJ passa a ser calculado
  normalmente** (1,5%, sujeito ao limite de R$10 por cliente/dia, igual aos demais).
- Cliente **Pessoa Física** → PIS, COFINS, CSLL e IRPJ = 0 (isenção total).
- Demais clientes (Não / pessoa jurídica) → PIS (0,65%), COFINS (3%) e CSLL (1%) são
  calculados juntos e só aparecem na nota se a **soma dos três** para o **mesmo cliente
  (CNPJ)** dentro do **mesmo envio de planilha** (tratado como "mesmo dia de emissão")
  for **maior que R$10,00** — caso contrário os três ficam zerados em todas as NFs
  daquele cliente naquele envio.
- **IRPJ (1,5%)** é calculado para todo cliente que não seja Pessoa Física (inclusive
  Simples Nacional) e é avaliado **isoladamente**: só aparece se a soma do IRPJ
  (sozinho) para o mesmo cliente/dia for maior que R$10,00.

**Valecare Engenharia**
- PIS, COFINS, CSLL e IRPJ sempre 0.

**ISS (ambas as empresas)**
- Só incide quando Cidade = Taubaté **e** Valor > R$600,00.
- Usa a alíquota informada na tela de upload (ela muda mês a mês, por isso é um campo
  editável a cada envio — o sistema guarda a última alíquota usada por empresa como
  sugestão no próximo envio).

> Essas regras foram validadas linha a linha contra o histórico real de julho/2026 de
> ambas as empresas (169 notas no total) e batem 100%, com uma única exceção pontual
> conhecida (um cliente específico com ISS aplicado abaixo de R$600 por algum motivo
> particular daquele cliente).

> **Importante sobre "mesmo dia":** como a planilha não traz uma coluna de data de
> emissão por linha, cada upload é tratado como um único lote/dia (você escolhe a data
> na tela de envio). Ou seja, o limite de R$10 agrupa por CNPJ **dentro do arquivo
> enviado**. Se você emitir para o mesmo cliente em envios separados no mesmo dia real,
> eles não serão somados entre si — avise se preferir outro comportamento.

## Formato da planilha de upload

Primeira aba do arquivo `.xlsx`, com estas colunas (nomes flexíveis quanto a acento/maiúsculas):

| Simples Nacional | Cidade | Cliente | CNPJ | Descrição | Venc. | Valor |
|---|---|---|---|---|---|---|

## Rodando localmente

```bash
cp .env.example .env   # edite DATABASE_URL, SESSION_SECRET, ADMIN_PASSWORD
npm install
npm run migrate        # cria as tabelas
npm run seed            # cria o usuário de login (usa ADMIN_USERNAME/ADMIN_PASSWORD do .env)
npm start
```

Acesse http://localhost:3000 e faça login com o usuário criado no seed.

## Deploy no EasyPanel (204.168.191.59)

1. **Suba este projeto para um repositório novo no GitHub**, ex: `eityiwamura/valecare-nf`.
2. **Crie o serviço de banco** no EasyPanel: um app PostgreSQL (mesmo padrão dos outros
   projetos). Anote o hostname interno gerado (padrão `NUMERO_nome-servico`).
3. **Crie o serviço da aplicação**:
   - Tipo: App a partir de GitHub (auto-deploy no push).
   - Build: usa o `Dockerfile` deste repositório.
   - Porta interna: `3000`.
   - Health check: `GET /health` (o Dockerfile já expõe um `HEALTHCHECK` compatível com Alpine).
   - Variáveis de ambiente (copie de `.env.example`):
     - `DATABASE_URL` → aponte para o hostname interno do Postgres criado no passo 2.
     - `DATABASE_SSL=false` (conexão interna do EasyPanel não precisa de SSL).
     - `SESSION_SECRET` → gere um valor aleatório longo.
     - `NODE_ENV=production`
     - `COOKIE_SECURE=true` (o Traefik do EasyPanel termina o HTTPS na frente do app).
     - `ADMIN_USERNAME` e `ADMIN_PASSWORD` (só usados pelo `npm run seed`).
4. **Configure o domínio** do serviço em Traefik/EasyPanel (SSL automático), como nos
   outros projetos (ex: `valecare-nf.iwamura.com.br`).
5. Após o primeiro deploy, abra o **console/terminal do serviço no EasyPanel** e rode:
   ```bash
   npm run migrate
   npm run seed
   ```
   Isso cria as tabelas e o usuário de login. Rodar `npm run seed` de novo com uma nova
   senha atualiza a senha do mesmo usuário.
6. Acesse o domínio configurado e faça login.

## Trocar a senha de login mais tarde

Basta rodar `npm run seed` novamente no console do serviço com `ADMIN_PASSWORD`
atualizado no `.env` (ou como variável de ambiente do EasyPanel).

## Estrutura do projeto

```
server.js              # bootstrap do Express, sessão, rotas
db/schema.sql           # schema PostgreSQL (empresas, configuracoes, lotes, notas_fiscais)
db/pool.js               # pool de conexão pg
services/calculo.js      # TODA a regra de negócio dos impostos (bem comentado)
services/parser.js       # leitura/normalização da planilha .xlsx enviada
routes/auth.js            # login/logout
routes/upload.js          # tela de envio + processamento da planilha
routes/notas.js            # histórico com filtros/paginação/ordenação
routes/dashboard.js         # agregações para os gráficos
views/                        # EJS (Urbanist + JetBrains Mono, tema claro/escuro)
scripts/migrate.js             # roda db/schema.sql
scripts/seed.js                  # cria/atualiza o usuário de login
```

## Alterar as regras de imposto

Toda a lógica fica isolada em `services/calculo.js`, comentada linha a linha — é o único
arquivo que precisa mudar se as alíquotas ou o limite de R$10 mudarem no futuro.
