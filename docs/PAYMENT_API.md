# Documentação da API de Pagamento

Esta documentação descreve como processar pagamentos através do endpoint de checkout.

## Endpoint

```
POST /api/v1/checkout/process
```

## Autenticação

Este endpoint requer autenticação via JWT. Inclua o token no header:

```
Authorization: Bearer {seu_token_jwt}
```

## Estrutura da Requisição

### Campos Principais

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `eventId` | string (UUID) | Sim | ID do evento |
| `paymentMethod` | enum | Sim | Método de pagamento: `PIX`, `CREDIT_CARD`, `BOLETO` |
| `payment` | object | Sim | Dados do pagamento (ver detalhes abaixo) |
| `tickets` | array | Sim | Array de ingressos selecionados |
| `participants` | array | Sim | Array de participantes (um para cada ingresso) |
| `couponCode` | string | Não | Código do cupom de desconto |
| `voucherCode` | string | Não | Código do voucher de desconto |
| `serviceFee` | number | Não | Taxa de serviço em centavos (padrão: 0) |

### ⚠️ Importante: Valores em Centavos

**Todos os valores monetários devem ser enviados em centavos (inteiros).**

Exemplos:
- R$ 100,00 = `10000` centavos
- R$ 1.500,50 = `150050` centavos
- R$ 0,50 = `50` centavos

---

## Métodos de Pagamento

### 1. PIX

Para pagamento via PIX, não é necessário enviar dados do cartão.

**Exemplo de Requisição:**

```json
{
  "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
  "paymentMethod": "PIX",
  "payment": {},
  "tickets": [
    {
      "ticketId": "abc123-def456-ghi789",
      "quantity": 2,
      "batchId": "batch-uuid-optional"
    }
  ],
  "participants": [
    {
      "name": "João Silva",
      "cpf": "12345678900",
      "email": "joao@example.com",
      "birthDate": "1990-01-01",
      "phone": "11999999999",
      "gender": "MALE",
      "questionAnswers": [
        {
          "questionId": "question-uuid",
          "answer": "Resposta da pergunta"
        }
      ],
      "products": [
        {
          "productId": "product-uuid",
          "variationId": "variation-uuid",
          "quantity": 1
        }
      ]
    },
    {
      "name": "Maria Santos",
      "cpf": "98765432100",
      "email": "maria@example.com",
      "birthDate": "1992-05-15",
      "phone": "11888888888",
      "gender": "FEMALE"
    }
  ],
  "couponCode": "PROMO2024",
  "serviceFee": 0
}
```

**Resposta:**

```json
{
  "success": true,
  "message": "Checkout processado com sucesso",
  "data": {
    "orderId": "order-uuid",
    "total": 15000,
    "pricing": {
      "ticketsSubtotal": 10000,
      "productsSubtotal": 5000,
      "serviceFee": 0,
      "couponDiscount": 0,
      "voucherDiscount": 0,
      "finalTotal": 15000
    },
    "registrations": [
      {
        "id": "registration-uuid-1",
        "status": "PENDING",
        "qrCode": "https://www.podioticket.com.br/user/tickets/registration-uuid-1",
        "participant": {
          "id": "user-uuid-1",
          "name": "João Silva",
          "email": "joao@example.com",
          "includedProducts": []
        }
      }
    ],
    "payment": {
      "method": "PIX",
      "status": "pending",
      "transactionId": "cielo-payment-id",
      "pix": {
        "qrCode": "00020126360014BR.GOV.BCB.PIX...",
        "qrCodeBase64": "data:image/png;base64,iVBORw0KG...",
        "expirationDate": "2024-01-15T10:30:00.000Z"
      }
    }
  }
}
```

---

### 2. Cartão de Crédito

Para pagamento com cartão de crédito, é necessário enviar os dados do cartão.

**Exemplo de Requisição:**

```json
{
  "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
  "paymentMethod": "CREDIT_CARD",
  "payment": {
    "card": {
      "name": "JOAO SILVA",
      "number": "1234567890123456",
      "expiry": "12/25",
      "cvv": "123",
      "installments": 1
    }
  },
  "tickets": [
    {
      "ticketId": "abc123-def456-ghi789",
      "quantity": 1
    }
  ],
  "participants": [
    {
      "name": "João Silva",
      "cpf": "12345678900",
      "email": "joao@example.com",
      "birthDate": "1990-01-01",
      "phone": "11999999999",
      "gender": "MALE",
      "products": [
        {
          "productId": "product-uuid",
          "variationId": "variation-uuid",
          "quantity": 2
        }
      ]
    }
  ],
  "couponCode": "DESCONTO10"
}
```

**Campos do Cartão:**

| Campo | Tipo | Descrição | Exemplo |
|-------|------|-----------|---------|
| `name` | string | Nome do portador (MAIÚSCULAS) | `"JOAO SILVA"` |
| `number` | string | Número do cartão (16 dígitos) | `"1234567890123456"` |
| `expiry` | string | Data de validade (MM/YY) | `"12/25"` |
| `cvv` | string | Código de segurança (3 ou 4 dígitos) | `"123"` |
| `installments` | number | Número de parcelas (1-12) | `1` |

**Resposta:**

```json
{
  "success": true,
  "message": "Checkout processado com sucesso",
  "data": {
    "orderId": "order-uuid",
    "total": 15000,
    "pricing": {
      "ticketsSubtotal": 10000,
      "productsSubtotal": 5000,
      "serviceFee": 0,
      "couponDiscount": 1500,
      "voucherDiscount": 0,
      "finalTotal": 13500
    },
    "registrations": [
      {
        "id": "registration-uuid",
        "status": "CONFIRMED",
        "qrCode": "https://www.podioticket.com.br/user/tickets/registration-uuid",
        "participant": {
          "id": "user-uuid",
          "name": "João Silva",
          "email": "joao@example.com",
          "includedProducts": []
        }
      }
    ],
    "payment": {
      "method": "CREDIT_CARD",
      "status": "approved",
      "transactionId": "cielo-payment-id",
      "creditCard": {
        "installments": 1,
        "installmentValue": 13500
      }
    }
  }
}
```

---

### 3. Boleto

Para pagamento via boleto, não é necessário enviar dados do cartão.

**Exemplo de Requisição:**

```json
{
  "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
  "paymentMethod": "BOLETO",
  "payment": {},
  "tickets": [
    {
      "ticketId": "abc123-def456-ghi789",
      "quantity": 1
    }
  ],
  "participants": [
    {
      "name": "João Silva",
      "cpf": "12345678900",
      "email": "joao@example.com",
      "birthDate": "1990-01-01",
      "phone": "11999999999",
      "gender": "MALE"
    }
  ]
}
```

**Resposta:**

```json
{
  "success": true,
  "message": "Checkout processado com sucesso",
  "data": {
    "orderId": "order-uuid",
    "total": 10000,
    "pricing": {
      "ticketsSubtotal": 10000,
      "productsSubtotal": 0,
      "serviceFee": 0,
      "couponDiscount": 0,
      "voucherDiscount": 0,
      "finalTotal": 10000
    },
    "registrations": [
      {
        "id": "registration-uuid",
        "status": "PENDING",
        "qrCode": "https://www.podioticket.com.br/user/tickets/registration-uuid",
        "participant": {
          "id": "user-uuid",
          "name": "João Silva",
          "email": "joao@example.com",
          "includedProducts": []
        }
      }
    ],
    "payment": {
      "method": "BOLETO",
      "status": "pending",
      "transactionId": "cielo-payment-id",
      "boleto": {
        "barcode": "34191090000000123456789012345678901234567890",
        "digitableLine": "34191.09000 00001.234567 89012.345678 9 01234567890",
        "expirationDate": "2024-01-18T10:30:00.000Z"
      }
    }
  }
}
```

---

## Estrutura Detalhada dos Campos

### Tickets

```json
{
  "ticketId": "uuid-do-ingresso",
  "quantity": 2,
  "batchId": "uuid-do-lote-opcional"
}
```

### Participants

Cada participante corresponde a um ingresso. Se você comprar 2 ingressos, deve enviar 2 participantes.

```json
{
  "name": "Nome Completo",
  "cpf": "12345678900",  // Apenas números, sem pontos ou traços
  "email": "email@example.com",
  "birthDate": "1990-01-01",  // Formato ISO 8601 (YYYY-MM-DD)
  "phone": "11999999999",  // Apenas números, com DDD
  "gender": "MALE",  // Opções: MALE, FEMALE, OTHER, PREFER_NOT_TO_SAY
  "emergencyContactName": "Maria Silva",  // Opcional
  "emergencyPhone": "11988888888",  // Opcional
  "hasEmergencyContact": true,  // Opcional
  "questionAnswers": [  // Opcional - Respostas para perguntas do evento
    {
      "questionId": "uuid-da-pergunta",
      "answer": "Resposta"  // Pode ser string, boolean ou number
    }
  ],
  "products": [  // Opcional - Produtos adicionais escolhidos
    {
      "productId": "uuid-do-produto",
      "variationId": "uuid-da-variacao",  // Opcional
      "quantity": 1
    }
  ]
}
```

### Question Answers

As respostas podem ser de diferentes tipos:

- **String**: `"Resposta em texto"`
- **Boolean**: `true` ou `false` (também aceita `"true"`, `"false"`, `"verdadeiro"`, `"falso"`)
- **Number**: `42` ou `"42"`

### Products

Produtos adicionais que podem ser comprados junto com o ingresso:

```json
{
  "productId": "uuid-do-produto",
  "variationId": "uuid-da-variacao",  // Opcional - se o produto tiver variações
  "quantity": 1
}
```

---

## Status de Pagamento

### PIX e Boleto

- **Status inicial**: `pending`
- **Confirmação**: O status é atualizado via webhook quando o pagamento é confirmado
- **Aguardar confirmação**: O pagamento pode levar alguns minutos para ser confirmado

### Cartão de Crédito

- **Status**: `approved` (se aprovado imediatamente) ou `pending` (se aguardando confirmação)
- **Aprovação imediata**: Depende da resposta do gateway de pagamento

---

## Status das Inscrições

As inscrições são criadas com os seguintes status:

- **CONFIRMED**: Quando o pagamento é aprovado imediatamente (geralmente cartão de crédito)
- **PENDING**: Quando o pagamento está pendente (PIX, Boleto, ou cartão aguardando confirmação)

O status da inscrição é atualizado automaticamente quando o pagamento é confirmado via webhook.

---

## Códigos de Resposta HTTP

| Código | Descrição |
|--------|-----------|
| `200` | Checkout processado com sucesso |
| `400` | Dados inválidos ou erro na validação |
| `401` | Não autenticado (token inválido ou ausente) |
| `404` | Evento, ingresso ou produto não encontrado |
| `500` | Erro interno do servidor |

---

## Exemplos de Erro

### Erro de Validação

```json
{
  "statusCode": 400,
  "message": [
    "cpf must be a string",
    "email must be an email",
    "payment.card.cvv must match /^\\d{3,4}$/ regular expression"
  ],
  "error": "Bad Request"
}
```

### Erro de Pagamento

```json
{
  "statusCode": 400,
  "message": "Falha ao processar pagamento: Cartão recusado",
  "error": "Bad Request"
}
```

---

## Observações Importantes

1. **Valores em Centavos**: Todos os valores monetários devem ser enviados em centavos (inteiros)

2. **CPF**: Deve conter apenas números, sem pontos ou traços

3. **Telefone**: Deve conter apenas números, incluindo DDD (ex: `11999999999`)

4. **Data de Nascimento**: Formato ISO 8601 (YYYY-MM-DD)

5. **Gênero**: Valores aceitos: `MALE`, `FEMALE`, `OTHER`, `PREFER_NOT_TO_SAY`

6. **Parcelas**: Para cartão de crédito, o número de parcelas deve estar entre 1 e 12

7. **Participantes**: O número de participantes deve corresponder à quantidade total de ingressos (soma de todas as quantidades)

8. **Produtos**: Os produtos são opcionais e podem ser adicionados a cada participante

9. **Cupons e Vouchers**: Podem ser aplicados em conjunto, os descontos são somados

10. **QR Code**: O QR Code retornado é um link para a página do ingresso no site, não um código PIX

---

## Exemplo Completo com cURL

### PIX

```bash
curl -X POST https://api.podioticket.com.br/api/v1/checkout/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer seu_token_jwt" \
  -d '{
    "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
    "paymentMethod": "PIX",
    "payment": {},
    "tickets": [
      {
        "ticketId": "abc123-def456-ghi789",
        "quantity": 1
      }
    ],
    "participants": [
      {
        "name": "João Silva",
        "cpf": "12345678900",
        "email": "joao@example.com",
        "birthDate": "1990-01-01",
        "phone": "11999999999",
        "gender": "MALE"
      }
    ]
  }'
```

### Cartão de Crédito

```bash
curl -X POST https://api.podioticket.com.br/api/v1/checkout/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer seu_token_jwt" \
  -d '{
    "eventId": "999ef0df-a1a3-4e10-95eb-7b2b8df6f0c7",
    "paymentMethod": "CREDIT_CARD",
    "payment": {
      "card": {
        "name": "JOAO SILVA",
        "number": "1234567890123456",
        "expiry": "12/25",
        "cvv": "123",
        "installments": 1
      }
    },
    "tickets": [
      {
        "ticketId": "abc123-def456-ghi789",
        "quantity": 1
      }
    ],
    "participants": [
      {
        "name": "João Silva",
        "cpf": "12345678900",
        "email": "joao@example.com",
        "birthDate": "1990-01-01",
        "phone": "11999999999",
        "gender": "MALE"
      }
    ]
  }'
```

---

## Suporte

Para dúvidas ou problemas, entre em contato com o suporte técnico.
