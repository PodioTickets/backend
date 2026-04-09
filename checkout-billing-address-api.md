# Endereço de cobrança no checkout (`billingAddress`)

O frontend envia o endereço confirmado na etapa de pagamento no corpo do **POST** já existente:

`POST /api/v1/checkout/process`

## Autenticação

- Header `Authorization: Bearer <access_token>` (igual ao checkout atual).
- Header `Content-Type: application/json`.

## Campo novo no JSON

| Campo             | Tipo   | Obrigatório | Descrição |
|-------------------|--------|-------------|-----------|
| `billingAddress`  | objeto | **sim**     | Endereço de cobrança confirmado pelo comprador antes de pagar (cartão ou PIX). |

### Objeto `billingAddress`

| Campo           | Tipo   | Obrigatório | Descrição |
|-----------------|--------|-------------|-----------|
| `country`       | string | sim         | Nome do país em português, como no seletor do checkout (ex.: `"Brasil"`). |
| `postalCode`    | string | sim         | **Brasil:** exatamente **8 dígitos**, sem hífen (ex.: `"01310100"`). **Exterior:** código postal como texto (trim; espaços internos colapsados). |
| `stateUf`       | string | recomendado | Sigla da unidade federativa em **maiúsculas** (ex.: `"SP"`, `"RJ"`). Para outros países, o frontend ainda envia o valor escolhido no fluxo (ex.: estado brasileiro ou equivalente usado na UI). |
| `street`        | string | sim         | Logradouro (rua, avenida, etc.). |
| `number`        | string | sim         | Número do imóvel. |
| `complement`    | string | não         | Complemento (apto, bloco, etc.). Omitir ou enviar `""` se vazio. |
| `neighborhood`  | string | sim         | Bairro. |
| `city`          | string | sim         | Cidade / município. |

Nenhum dado de cartão é duplicado aqui; este bloco é só endereço de cobrança.

## Exemplo de corpo (trecho)

```json
{
  "eventId": "uuid-do-evento",
  "paymentMethod": "PIX",
  "payment": {},
  "tickets": [{ "ticketId": "uuid", "quantity": 1 }],
  "participants": [
    {
      "name": "Fulano da Silva",
      "cpf": "12345678901",
      "email": "fulano@email.com",
      "birthDate": "1990-01-15",
      "phone": "11999999999"
    }
  ],
  "billingAddress": {
    "country": "Brasil",
    "postalCode": "01310100",
    "stateUf": "SP",
    "street": "Avenida Paulista",
    "number": "1000",
    "complement": "Sala 12",
    "neighborhood": "Bela Vista",
    "city": "São Paulo"
  },
  "serviceFee": 500
}
```

## Comportamento esperado no backend

1. **Validação**  
   - Rejeitar `400` se `billingAddress` estiver ausente ou se campos obrigatórios estiverem vazios.  
   - Para `country === "Brasil"`, validar `postalCode` com 8 dígitos numéricos.

2. **Persistência sugerida**  
   Associar o endereço ao pedido / registro / pagamento que o checkout já cria, por exemplo:
   - Colunas em `registrations` ou `orders`: `billing_country`, `billing_postal_code`, `billing_state_uf`, `billing_street`, `billing_number`, `billing_complement`, `billing_neighborhood`, `billing_city`; ou  
   - Tabela `billing_addresses` com FK para `order_id` / `registration_id` / `payment_id`.

3. **Compatibilidade**  
   Clientes antigos que não enviam `billingAddress` devem ser tratados até a migração (opcional: aceitar omitido com valor nulo no banco) **ou** o backend pode exigir o campo e retornar erro claro — o frontend atual **sempre** envia após confirmação do endereço.

4. **Privacidade**  
   Tratar como dado pessoal (LGPD): base legal, retenção e acesso alinhados aos demais dados do participante.

## Referência no código frontend

- Tipo: `CheckoutBillingAddressRequest` e `CheckoutRequest.billingAddress` em `src/interfaces/checkout.ts`.  
- Montagem do payload: `buildBillingAddressPayload` / `prepareCheckoutData` em `src/components/Checkout/PaymentStep.tsx`.  
- Envio: `src/hooks/useCheckoutPayment.ts` → `JSON.stringify` do `CheckoutRequest` completo.
