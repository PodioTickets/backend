-- Assessor responsável pela organização (widget de suporte do painel).
-- Criar o TIPO e usá-lo na mesma transação é permitido; a restrição do Postgres
-- vale só para ADICIONAR valor a um enum já existente e referenciá-lo em seguida.
CREATE TYPE "OrganizationAdvisor" AS ENUM ('GUARIM', 'LUCAS_SANTOS');

-- NOT NULL com DEFAULT: no Postgres 11+ o default vai para o catálogo em vez de
-- reescrever a tabela. Todas as orgs existentes seguem com o assessor atual.
ALTER TABLE "Organization"
  ADD COLUMN "advisor" "OrganizationAdvisor" NOT NULL DEFAULT 'GUARIM';
