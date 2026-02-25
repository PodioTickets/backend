#!/bin/bash

echo "=== Verificando variáveis de ambiente da Cielo ==="
echo ""

echo "1. Verificando arquivo .env:"
if [ -f .env ]; then
    echo "✅ Arquivo .env existe"
    echo ""
    echo "Variáveis da Cielo no .env:"
    grep -i "CIELO" .env | sed 's/=.*/=***/' || echo "❌ Nenhuma variável CIELO encontrada no .env"
else
    echo "❌ Arquivo .env não encontrado!"
fi

echo ""
echo "2. Verificando variáveis no container:"
docker compose exec backend sh -c 'echo "CIELO_MERCHANT_ID=${CIELO_MERCHANT_ID:-NOT_SET}"; echo "CIELO_MERCHANT_KEY=${CIELO_MERCHANT_KEY:-NOT_SET}"; echo "CIELO_ENV=${CIELO_ENV:-NOT_SET}"' || echo "❌ Erro ao executar comando no container"

echo ""
echo "3. Verificando logs do backend para mensagens da Cielo:"
docker compose logs backend | grep -i "cielo" | tail -10 || echo "Nenhuma mensagem da Cielo encontrada nos logs"

echo ""
echo "4. Testando se as variáveis estão acessíveis:"
docker compose exec backend node -e "
const merchantId = process.env.CIELO_MERCHANT_ID;
const merchantKey = process.env.CIELO_MERCHANT_KEY;
console.log('CIELO_MERCHANT_ID:', merchantId ? merchantId.substring(0, 4) + '***' : 'NOT_SET');
console.log('CIELO_MERCHANT_KEY:', merchantKey ? '***SET*** (length: ' + merchantKey.length + ')' : 'NOT_SET');
console.log('CIELO_ENV:', process.env.CIELO_ENV || 'NOT_SET');
" || echo "❌ Erro ao testar variáveis"
