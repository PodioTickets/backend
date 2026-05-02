# Regras do projeto — Backend

## Antes de todo commit, verificar obrigatoriamente

### Qualidade de código
- Nunca usar `console.log` — usar `this.logger` (NestJS `Logger`) com nível adequado (`log`, `warn`, `error`)
- Sem `any` explícito sem comentário justificando (ex: `// Prisma JSON field`)
- Lógica de formatação/transformação fora de templates e controladores — extrair como função helper nomeada no escopo do módulo
- Sem IIFEs inline em chamadas de `React.createElement` nos templates PDF

### Tratamento de erros
- Toda operação assíncrona fora de transação Prisma deve ter `.catch()` com log
- Operações fire-and-forget (envio de email, geração de PDF) nunca podem estourar para o caller — envolver em `.catch()`
- Geração de múltiplos PDFs deve ser **sequencial** (`await` em série), não paralela — yoga-layout não suporta renders simultâneos

### Segurança
- **Todo dado externo passado a templates HTML de email deve passar por `this.escapeHtml()`** — sem exceção, incluindo URLs (`bannerUrl`, `logoUrl`)
- Nunca interpolar variáveis de usuário diretamente em strings SQL ou queries Prisma raw
- Nunca commitar: `.env`, chaves de API, tokens, arquivos de teste com dados reais (`test-emails.mjs`, `prisma/*.ts` de scripts locais)
- Webhooks externos: sempre verificar idempotência antes de aplicar efeitos colaterais (padrão `updateMany` com condição de status já implementado)
- Dados de `metadata` Prisma (JSON) acessados com cast `as any` — sempre usar `?.` para evitar crash em registros antigos sem o campo

### Templates PDF (`@react-pdf/renderer`)
- Templates ficam em arquivos `.ts` com `React.createElement` — sem JSX, sem `.tsx`
- Nunca importar componentes browser (HTML SVG, ícones de libs web) diretamente — converter via `renderToStaticMarkup` → `sharp` → base64 se necessário

## Commits e push
- Sempre em **português**
- Sempre **detalhados**: subject line + body descrevendo o que mudou e por quê
- Formato: `tipo: resumo curto\n\n- detalhe 1\n- detalhe 2`
- Sem `Co-Authored-By: Claude` ou rastro de IA
- Nunca commitar: `.env`, chaves de API, arquivos de teste temporários
- **`git push` somente quando o usuário pedir explicitamente**

## Comentários no código
- Todos os comentários em código (inline, bloco, JSDoc) devem ser escritos em **português**
