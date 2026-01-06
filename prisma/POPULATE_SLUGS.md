# Script para Popular Slugs de Eventos

Este script popula os slugs para eventos existentes no banco de dados que ainda não possuem slug.

## Como usar

### Desenvolvimento (TypeScript)

```bash
pnpm db:populate-slugs
```

ou

```bash
ts-node prisma/populate-event-slugs.ts
```

### Produção (após build)

Se você precisar executar em produção, primeiro compile o projeto e depois execute:

```bash
# 1. Compilar o projeto
pnpm build

# 2. Executar o script compilado
node dist/prisma/populate-event-slugs.js
```

**Nota:** Para produção, você precisaria compilar o script separadamente ou criar uma versão JavaScript manual.

## O que o script faz

1. **Busca eventos sem slug**: Encontra todos os eventos que têm `slug = null`
2. **Gera slugs únicos**: Para cada evento, gera um slug baseado no nome do evento
3. **Garante unicidade**: Se o slug já existir, adiciona um sufixo numérico (ex: `meu-evento-1`, `meu-evento-2`)
4. **Atualiza o banco**: Salva o slug gerado no banco de dados

## Exemplo de saída

```
🔄 Buscando eventos sem slug...
📝 Encontrados 5 eventos sem slug
🚀 Gerando slugs...

✅ Corrida de Rua São Paulo 2025 → corrida-de-rua-sao-paulo-2025
✅ Maratona Internacional → maratona-internacional
✅ Triathlon Beach → triathlon-beach
✅ Corrida Noturna → corrida-noturna
✅ Circuito de Ciclismo → circuito-de-ciclismo

📊 Resumo:
   ✅ Sucesso: 5
   ❌ Erros: 0
   📝 Total processado: 5
```

## Quando executar

Execute este script:

- **Após aplicar a migration** que adiciona o campo `slug` ao banco de dados
- **Antes de publicar** a nova versão da API que usa slugs
- **Sempre que** houver eventos sem slug no banco

## Segurança

- O script é **idempotente**: pode ser executado múltiplas vezes sem problemas
- Apenas eventos **sem slug** são processados
- Slugs já existentes **não são alterados**

## Requisitos

- Banco de dados acessível (configurado via `DATABASE_URL` no `.env`)
- Prisma Client gerado (`pnpm db:generate`)
- Migration aplicada (`pnpm db:migrate`)

