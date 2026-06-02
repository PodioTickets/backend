# Guia de Testes Unitários — Backend PodioTickets

> Padrão **obrigatório** para todo teste unitário do backend. O objetivo é que **qualquer pessoa**
> consiga abrir um spec e entender, em segundos, **o que** está sendo testado, **quais regras**
> são cobertas e **como** o teste funciona.

## 1. Princípios

- **O mais próximo do real possível (menos faz-de-conta)**: quanto menos a gente simula, mais o teste
  vale. A meta é exercitar o código DE VERDADE. Hierarquia:
  1. **Função pura** (cálculo/validação que não depende de banco) → roda 100% real, **zero** simulação.
  2. **Fluxo que mexe no banco** → roda contra um **banco de teste de verdade** (descartável, separado do
     real), quando essa infra existir (ver §6). Só assim o SQL, as regras do banco e as transações são reais.
  3. **Serviços externos** (cobrança Cielo, e-mail, WhatsApp, etc.) → **sempre** simulados. Não dá (nem é
     seguro) cobrar um cartão de verdade ou disparar e-mail real num teste. Isso é a ÚNICA simulação inevitável.
- **Determinístico**: mesmo cenário → mesmo resultado, sempre. Nada de depender de relógio real
  (`Date.now()`), de ordem entre testes, ou de dados que mudam sozinhos.
- **Colocado**: o spec mora em `__tests__/` ao lado do código (`src/app/x/__tests__/x.service.spec.ts`).
- **Idioma PT-BR e linguagem comum** em títulos e cabeçalho (qualquer pessoa entende — ver §3).
- **Type-checado**: o jest usa `ts-jest`, então o spec compila o código sob teste (pega erro de tipo).
- **Foco em comportamento**, não em implementação: testa-se o que o usuário/produto espera, não detalhes
  internos que mudam à toa.

## 2. Nomenclatura

| Situação | Nome |
|---|---|
| Spec principal de uma unidade | `<arquivo>.spec.ts` — ex.: `tickets.service.spec.ts` |
| Spec focado num assunto/feature | `<arquivo>.<assunto>.spec.ts` — ex.: `questions.options-validation.spec.ts` |

Specs focados são incentivados quando uma unidade é grande: cada arquivo cobre um eixo coeso
(ex.: `repasse.event-rates.spec.ts`, `events.financial-pending.spec.ts`).

## 3. Cabeçalho ROTEIRO (OBRIGATÓRIO) — escrito para QUALQUER pessoa

Todo spec começa com um bloco que explica o teste **em linguagem do dia a dia**, sem termo técnico.
Regra de ouro: escreva como se fosse explicar para alguém que **não é de tecnologia** (um colega do
comercial, do financeiro, um cliente). Nada de "mock", "Prisma", "DTO", "interceptor", "DI". Fale do
COMPORTAMENTO do produto.

```ts
/**
 * ============================================================================
 *  O QUE ESTE TESTE VERIFICA   (explicado para qualquer pessoa)
 * ============================================================================
 *  RECURSO: <nome em linguagem comum — ex.: "Categorias de ingresso de um evento">
 *
 *  EM RESUMO:
 *    <1–3 frases, SEM jargão, dizendo o que essa parte do sistema faz e por que
 *     importa para quem usa o produto.>
 *
 *  O QUE PRECISA SEMPRE FUNCIONAR (cada item vira um teste aqui embaixo):
 *    • <regra do dia a dia — ex.: "Se o organizador não escolher a posição da
 *       categoria, ela entra automaticamente no final da lista.">
 *    • <ex.: "Não dá para apagar uma categoria que já tem ingressos dentro.">
 *
 *  COMO CONFERIMOS:
 *    <em 1–3 frases simples: o que o teste faz de fato. Ex.: "Simulamos um
 *     organizador criando, editando e apagando categorias e conferimos se o
 *     sistema responde do jeito certo.">
 *    <Se algo for 'de faz-de-conta', explique o porquê em linguagem leiga — ex.:
 *     "O envio de e-mail é simulado para não disparar e-mail de verdade durante o teste.">
 * ============================================================================
 */
```

Teste do cabeçalho: se uma pessoa de fora do time de dev lê e entende **o que o sistema faz** e
**o que está sendo garantido**, o ROTEIRO cumpriu o papel. Detalhe técnico fica no código, não aqui.

### Títulos dos testes também em linguagem comum
Cada `it('…')` é uma frase que qualquer pessoa entende, no formato **"faz X quando Y"**:
- ✅ `it('coloca a categoria no final da lista quando o organizador não escolhe a posição')`
- ✅ `it('não deixa apagar categoria que ainda tem ingressos')`
- ❌ `it('retorna 400 no reorder com array de tamanho divergente')` (jargão — reescreva)

## 4. Estrutura interna (describe / it / AAA)

- **`describe('<Unidade>.<método>', …)`** — um bloco por método público (ou por comportamento coeso).
  Sub-`describe` para agrupar variações (ex.: `describe('quando o cupom é AGE', …)`).
- **`it('<frase afirmativa: RESULTADO esperado + CONDIÇÃO>', …)`** — a frase descreve o comportamento,
  não o código. Bom: `it('cobra a taxa do evento quando não há valor congelado')`. Ruim: `it('testa refundFee')`.
- **Corpo em AAA**, com marcadores quando ajudar a leitura:
  ```ts
  it('rejeita opção duplicada', () => {
    // Arrange — monta entrada/mocks
    const dto = { type: 'select', options: ['A', 'A'] };
    // Act + Assert — executa e verifica
    expect(() => service.validate(dto)).toThrow(BadRequestException);
  });
  ```

## 5. Cobertura mínima por função pública

Para CADA função pública, cobrir (quando aplicável):

1. **Caminho feliz** — entrada típica → saída/efeito esperado.
2. **Edge cases** — vazio, limite/fronteira, `null`/`undefined`, duplicado, lista de 1, valor 0 (falsy).
3. **Erros/exceções** — entrada inválida → exceção CERTA (tipo + por quê); permissão negada → 401/403.
4. **Invariantes documentadas** — ex.: `Σ partes == total`, idempotência, "fonte única", fallback de legado.

> Marque com `it.todo('<caso>')` qualquer cenário conhecido ainda não coberto — vira backlog visível.

## 6. Quão "de verdade" cada teste roda (decisão do projeto: máximo realismo)

Dois tipos de arquivo, escolhidos pela natureza do código:

### 6.1 Teste unitário — `*.spec.ts` (sem banco)
Para **funções puras** (conta/validação) e peças que não tocam o banco (ex.: interceptors). Roda 100% real,
rápido, sem infra. Pure util → chamada direta. O ÚNICO "faz-de-conta" aceitável aqui é trocar uma dependência
externa (ex.: o "buscador de dados" de um controller fino) — e ainda assim a regra real é testada no spec dela.

### 6.2 Teste de integração — `*.int.spec.ts` (banco REAL de teste)
Para **services** e qualquer fluxo que mexe no banco. Roda contra um Postgres **descartável** (porta 5434,
`docker-compose.test.yml`) — assim SQL, regras do banco e transações são reais. Helpers em
`src/common/testing/integration-db.ts`:

```ts
import { createTestPrisma, resetDb, seedOrgUserEvent } from 'src/common/testing/integration-db';

let prisma; let service;
beforeAll(async () => { prisma = createTestPrisma(); await prisma.$connect(); service = new XService(prisma); });
afterAll(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(prisma); });           // banco limpo antes de cada cenário

it('faz X', async () => {
  const { adminUserId, eventId } = await seedOrgUserEvent(prisma); // cria linhas REAIS
  await service.create(adminUserId, eventId, { ... });
  const noBanco = await prisma.ticketCategory.findMany({ where: { eventId } }); // confere lendo o banco
  expect(...);
});
```

Rodar:
```bash
pnpm test:db:up      # sobe o Postgres de teste (uma vez)
pnpm test:int        # roda os *.int.spec.ts (aplica o schema via prisma db push e executa)
pnpm test:db:down    # derruba o banco de teste
```
> O schema do banco de teste vem de `prisma db push` (estado final do `schema.prisma`), NÃO de
> `migrate deploy` — o histórico de migrations tem um drift de ordenação que só não quebra na homolog
> por causa de restore de dump. Em teste só importa o schema final.

### 6.3 O que NUNCA é real (sempre simulado)
Serviços externos com efeito colateral/custo: **Cielo (cobrança), e-mail, WhatsApp, push, upload p/ CDN**.
Não dá (nem é seguro) cobrar cartão ou disparar e-mail num teste. Injete um substituto e verifique que foi
chamado com os argumentos certos (ex.: `expect(email.sendX).toHaveBeenCalledWith(...)`).

### 6.4 Dicas
- **Acesso de organizador**: em integração, crie um usuário real `role: 'ADMIN'` (passa direto) ou um
  `OrganizationMember` real para o caminho de membro; para negar, um usuário comum sem vínculo.
- **Tempo/aleatório**: nunca dependa de `Date.now()` real — use datas fixas (ex.: evento em 2030) ou fake timers.
- **SQL raw** (quando ficar em unit): inspecione `sql.values`/`sql.sql` do objeto `Prisma.Sql`.

## 7. Execução

```bash
npx jest <caminho-do-spec>      # um spec
npx jest src/app/<modulo>       # um módulo
npx jest                        # tudo
```

- O jest já roda com `clearMocks`/`restoreMocks` (isolamento entre testes).
- Cobertura: `npx jest --coverage` (threshold global em jest.config.js: branches 70 / functions 75 / lines 80 / statements 80).

## 8. Exemplos de referência (seguem este padrão)

- `src/common/utils/__tests__/refund.util.spec.ts` — util pura.
- `src/app/repasse/__tests__/repasse.event-rates.spec.ts` — service, lógica de dinheiro, casos adversariais.
- `src/app/questions/__tests__/questions.options-validation.spec.ts` — validação com edge cases + erros.
- `src/app/geo/__tests__/geo.service.spec.ts` — service sem DI (dataset estático).
- `src/app/admin/__tests__/admin-events.financial-settings.spec.ts` — captura de argumentos (write-path).

## 9. Definição de pronto (checklist por unidade)

- [ ] Spec colocado em `__tests__/` com cabeçalho ROTEIRO preenchido.
- [ ] Todas as funções públicas têm ao menos caminho feliz + 1 erro/edge.
- [ ] Títulos `it(...)` descrevem resultado+condição em PT-BR.
- [ ] Verde localmente (`npx jest <spec>`), sem `any` desnecessário e sem dependência de ordem entre testes.
- [ ] Cenários não cobertos marcados como `it.todo(...)`.
