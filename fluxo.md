# 📋 Fluxo Completo da Plataforma PodioGo

## 🎯 Visão Geral

A plataforma PodioGo é dividida em **3 perfis principais**:
- **Admin/PodioGo Staff**: Gestão da plataforma
- **Organizador**: Criar e gerenciar eventos
- **Usuário**: Participar de eventos

---

## 🔐 1. CRIAÇÃO E CONFIGURAÇÃO INICIAL

### 1.1 Criação do Primeiro Admin

**Método**: Criado manualmente via banco de dados ou API (requer autenticação especial)

```bash
# Endpoint: POST /api/v1/user
# Requer: JWT Auth + Admin Guard
# Apenas admins podem criar outros admins
```

**Dados necessários:**
```json
{
  "email": "admin@podiogo.com",
  "password": "SenhaSegura123!",
  "firstName": "Admin",
  "lastName": "PodioGo",
  "role": "ADMIN",
  "acceptedTerms": true,
  "acceptedPrivacyPolicy": true
}
```

**Permissões do Admin:**
- ✅ Criar/editar/deletar usuários
- ✅ Gerenciar organizadores
- ✅ Visualizar todos os eventos
- ✅ Acessar relatórios do sistema
- ✅ Configurar sistema

### 1.2 Criação de PodioGo Staff

**Fluxo**: Similar ao Admin, mas com role `PODIOGO_STAFF`

**Permissões:**
- ✅ Suporte a usuários e organizadores
- ✅ Visualizar eventos e inscrições
- ✅ Acessar relatórios
- ❌ Não pode criar admins

---

## 👨‍💼 2. FLUXO DO ORGANIZADOR

### 2.1 Cadastro do Organizador

**Passo 1**: Usuário se registra como usuário comum
```
POST /api/v1/auth/register
```

**Passo 2**: Usuário cria perfil de organizador
```
POST /api/v1/organizers
Authorization: Bearer {token}
```

**Dados:**
```json
{
  "name": "Maratona São Paulo",
  "email": "contato@maratonasp.com.br",
  "phone": "11999999999",
  "description": "Organizador de eventos esportivos"
}
```

**Resultado:**
- ✅ Role do usuário muda para `ORGANIZER`
- ✅ Perfil de organizador criado
- ✅ Agora pode criar eventos

### 2.2 Criar Evento

**Endpoint:** `POST /api/v1/events`

**Dados necessários:**
```json
{
  "name": "Maratona de São Paulo 2025",
  "description": "Maior maratona da cidade",
  "location": "Parque Ibirapuera",
  "city": "São Paulo",
  "state": "SP",
  "country": "BR",
  "eventDate": "2025-06-15T08:00:00Z",
  "registrationStartDate": "2025-06-10T23:59:59Z",
  "registrationEndDate": "2025-06-10T23:59:59Z",
  "googleMapsLink": "https://maps.google.com"
}
```

**Status inicial:** `DRAFT`

### 2.3 Criar Grupos de Modalidades

**Endpoint:** `POST /api/v1/modalities/events/{eventId}/groups`

**Exemplo:**
```json
{
  "name": "Corridas",
  "description": "Modalidades de corrida",
  "order": 1
}
```

### 2.4 Criar Modalidades

**Endpoint:** `POST /api/v1/modalities/events/{eventId}`

**Exemplo:**
```json
{
  "groupId": "5c531c18-e11d-42ae-b915-82c40ff6757a",
  "name": "Corrida 5K",
  "description": "Corrida de 5 quilômetros",
  "price": 100.00,
  "maxParticipants": 500,
  "isActive": true,
  "order": 1
}
```

**Modalidades comuns:**
- Corrida 5K - R$ 100,00
- Corrida 10K - R$ 150,00
- Meia Maratona (21K) - R$ 200,00
- Maratona (42K) - R$ 300,00
- Caminhada - R$ 50,00

### 2.5 Criar Kits

**Endpoint:** `POST /api/v1/kits/events/{eventId}`

**Exemplo:**
```json
{
  "name": "Kit Atleta Completo",
  "description": "Kit com todos os itens do evento",
  "isActive": true,
  "items": [
    {
      "name": "Camiseta Oficial",
      "description": "Camiseta técnica do evento",
      "sizes": [
        { "size": "P", "stock": 100 },
        { "size": "M", "stock": 200 },
        { "size": "G", "stock": 200 },
        { "size": "GG", "stock": 100 }
      ],
      "isActive": true
    },
    {
      "name": "Mochila",
      "description": "Mochila do evento",
      "sizes": [
        { "size": "Único", "stock": 500 }
      ]
    }
  ]
}
```

### 2.6 Criar Perguntas do Evento

**Endpoint:** `POST /api/v1/questions/events/{eventId}`

**Exemplo:**
```json
{
  "question": "Você já participou de maratonas antes?",
  "type": "select",
  "options": ["Sim", "Não", "Primeira vez"],
  "isRequired": true,
  "order": 1
}
```

**Tipos de perguntas:**
- `text`: Resposta livre
- `select`: Dropdown
- `radio`: Escolha única
- `checkbox`: Múltipla escolha

### 2.7 Publicar Evento

**Endpoint:** `PATCH /api/v1/events/{eventId}`

**Ação:** Alterar status de `DRAFT` para `PUBLISHED`

**Validações antes de publicar:**
- ✅ Deve ter pelo menos 1 modalidade ativa
- ✅ Data do evento deve ser futura
- ✅ Data de início de inscrições deve ser futura
- ✅ Data de fim de inscrições deve ser antes da data do evento

---

## 👤 3. FLUXO DO USUÁRIO

### 3.1 Buscar Eventos

**Endpoint:** `GET /api/v1/events`

**Filtros disponíveis:**
- País, Estado, Cidade
- Nome do evento
- Data (esta semana, este mês, range)
- Status (PUBLISHED)

**Retorno:**
```json
{
  "data": {
    "events": [
      {
        "id": "event-uuid",
        "name": "Maratona de São Paulo 2025",
        "city": "São Paulo",
        "state": "SP",
        "eventDate": "2025-06-15T08:00:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150
    }
  }
}
```

### 3.2 Visualizar Detalhes do Evento

**Endpoint:** `GET /api/v1/events/{eventId}`

**Informações exibidas:**
- Banner do evento
- Nome, local, data
- Descrição completa
- Informações do kit
- Premiação
- Regulamento
- Mapa (Google Maps)
- Dados do organizador
- Botão de contato
- Opções de compartilhar

### 3.3 Cadastro/Login

**Cadastro:** `POST /api/v1/auth/register`

**Dados obrigatórios:**
```json
{
  "email": "usuario@example.com",
  "password": "SenhaSegura123!",
  "firstName": "João",
  "lastName": "Silva",
  "acceptedTerms": true,
  "acceptedPrivacyPolicy": true
}
```

**Login:** `POST /api/v1/auth/login/email`

**Dados:**
```json
{
  "emailOrCpf": "usuario@example.com",
  "password": "SenhaSegura123!"
}
```

**Retorno:**
```json
{
  "success": true,
  "data": {
    "access_token": "jwt-token",
    "refresh_token": "refresh-token",
    "user": {
      "id": "user-uuid",
      "email": "usuario@example.com",
      "firstName": "João",
      "lastName": "Silva"
    }
  }
}
```

### 3.4 Selecionar Modalidade e Kit

**Fluxo interno** (frontend):
1. Usuário visualiza modalidades disponíveis
2. Seleciona uma ou mais modalidades
3. Seleciona itens do kit (tamanho, quantidade)
4. Preenche questionários do evento
5. Aceita termos e regulamento

### 3.5 Criar Inscrição

**Endpoint:** `POST /api/v1/registrations`
**Authorization:** Bearer {token}

**Exemplo básico:**
```json
{
  "eventId": "dbd1b39d-7b0a-4dec-830b-68a8fed49d97",
  "modalities": [
    { "modalityId": "modality-5k-uuid" }
  ],
  "kitItems": [
    {
      "kitItemId": "camiseta-uuid",
      "size": "G",
      "quantity": 1
    }
  ],
  "questionAnswers": [
    {
      "questionId": "question-uuid",
      "answer": "Sim, já participei antes"
    }
  ],
  "termsAccepted": true,
  "rulesAccepted": true
}
```

**Exemplo com convidado:**
```json
{
  "eventId": "event-uuid",
  "modalities": [{ "modalityId": "modality-5k-uuid" }],
  "kitItems": [],
  "questionAnswers": [],
  "termsAccepted": true,
  "rulesAccepted": true,
  "invitedUser": {
    "email": "amigo@example.com",
    "firstName": "Maria",
    "lastName": "Santos",
    "documentNumber": "12345678901"
  }
}
```

**O que acontece:**
1. ✅ Validação do evento (aberto, datas válidas)
2. ✅ Validação das modalidades (ativas, vagas disponíveis)
3. ✅ Validação do estoque dos kits
4. ✅ Cálculo do valor total:
   - Soma dos preços das modalidades
   - Taxa de serviço (5%)
   - Valor final
5. ✅ Criação da inscrição com status `PENDING`
6. ✅ Geração do QR Code único
7. ✅ Se houver convidado:
   - Criação de usuário pré-cadastrado
   - Envio de email com link para definir senha
8. ✅ Atualização de contadores (participantes por modalidade)
9. ✅ Atualização de estoque dos kits

**Retorno:**
```json
{
  "message": "Registration created successfully",
  "data": {
    "registration": {
      "id": "registration-uuid",
      "eventId": "event-uuid",
      "status": "PENDING",
      "totalAmount": 100.00,
      "serviceFee": 5.00,
      "finalAmount": 105.00,
      "qrCode": "data:image/png;base64,...",
      "modalities": [...],
      "kitItems": [...],
      "questionAnswers": [...]
    }
  }
}
```

### 3.6 Criar Pagamento

**Endpoint:** `POST /api/v1/payments`
**Authorization:** Bearer {token}

**Exemplo PIX:**
```json
{
  "registrationId": "registration-uuid",
  "method": "PIX",
  "metadata": {}
}
```

**Exemplo Cartão:**
```json
{
  "registrationId": "registration-uuid",
  "method": "CREDIT_CARD",
  "metadata": {
    "cardNumber": "4111111111111111",
    "holderName": "JOAO SILVA",
    "expirationDate": "12/25",
    "securityCode": "123"
  }
}
```

**O que acontece:**
1. ✅ Validação da inscrição (pertence ao usuário, não cancelada)
2. ✅ Criação do pagamento na Cielo
3. ✅ Criação do registro de pagamento no banco
4. ✅ Se PIX: retorna QR Code e código para pagamento
5. ✅ Se Cartão: processa pagamento imediatamente

**Retorno PIX:**
```json
{
  "message": "Payment created successfully",
  "data": {
    "payment": {
      "id": "payment-uuid",
      "status": "PENDING",
      "amount": 105.00,
      "method": "PIX",
      "transactionId": "cielo-transaction-id"
    },
    "pixCode": "00020126...",
    "qrCode": "data:image/png;base64,...",
    "expiresAt": "2025-11-05T10:00:00Z"
  }
}
```

### 3.7 Confirmação de Pagamento

**Fluxo automático:**
1. Webhook da Cielo notifica pagamento
2. Sistema atualiza status do pagamento para `PAID`
3. Sistema atualiza status da inscrição para `CONFIRMED`
4. Email de confirmação enviado ao usuário

**Endpoint:** `POST /api/v1/payments/{paymentId}/confirm` (webhook interno)

### 3.8 Visualizar Ingressos

**Endpoint:** `GET /api/v1/registrations/me`
**Authorization:** Bearer {token}

**Retorno:**
```json
{
  "data": {
    "registrations": [
      {
        "id": "registration-uuid",
        "event": {
          "name": "Maratona de São Paulo 2025",
          "eventDate": "2025-06-15T08:00:00Z"
        },
        "purchaseDate": "2025-01-15T10:30:00Z",
        "status": "CONFIRMED",
        "qrCode": "data:image/png;base64,...",
        "user": {
          "firstName": "João",
          "lastName": "Silva",
          "documentNumber": "12345678901"
        },
        "modalities": [
          {
            "modality": {
              "name": "Corrida 5K",
              "price": 100.00
            }
          }
        ],
        "kitItems": [
          {
            "kitItem": {
              "name": "Camiseta Oficial"
            },
            "selectedSize": "G",
            "quantity": 1
          }
        ]
      }
    ]
  }
}
```

---

## 🔄 4. FLUXOS ESPECIAIS

### 4.1 Inscrição de Convidado

**Cenário:** Usuário A compra ingresso para Usuário B

**Fluxo:**
1. Usuário A seleciona "Adicionar outro participante"
2. Preenche dados básicos (email, nome, CPF)
3. Seleciona modalidade e kit para o convidado
4. Cria inscrição com `invitedUser`
5. Sistema cria usuário pré-cadastrado (`isActive: false`)
6. Email enviado ao convidado com link de ativação
7. Convidado acessa link e define senha
8. Conta ativada (`isActive: true`)
9. Convidado pode visualizar seu ingresso

### 4.2 Validação na Entrada do Evento

**Cenário:** Organizador valida QR Code na entrada

**Endpoint:** `GET /api/v1/registrations/{registrationId}/validate`

**Validações:**
- ✅ QR Code válido
- ✅ Evento corresponde ao evento atual
- ✅ Status da inscrição é `CONFIRMED`
- ✅ Pagamento foi confirmado (`PAID`)
- ✅ Data do evento é hoje

**Retorno:**
```json
{
  "valid": true,
  "registration": {
    "user": {
      "firstName": "João",
      "lastName": "Silva"
    },
    "modalities": [...],
    "qrCode": "..."
  }
}
```

### 4.3 Cancelamento de Inscrição

**Endpoint:** `PATCH /api/v1/registrations/{registrationId}/cancel`

**Validações:**
- ✅ Inscrição pertence ao usuário
- ✅ Data de cancelamento antes do evento
- ✅ Status pode ser cancelado

**Ações:**
- Status muda para `CANCELLED`
- Decrementa contadores de participantes
- Libera estoque dos kits
- Processa reembolso (se aplicável)

### 4.4 Relatórios do Organizador

**Endpoints:**
- `GET /api/v1/events/{eventId}/registrations` - Lista inscrições
- `GET /api/v1/events/{eventId}/stats` - Estatísticas do evento
- `GET /api/v1/events/{eventId}/revenue` - Receita total

---

## 📊 5. DIAGRAMA DE FLUXO

```
┌─────────────────────────────────────────────────────────────┐
│                    INÍCIO DO SISTEMA                        │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        ┌─────────────────────────────────────┐
        │   Admin cria primeiro usuário admin  │
        └─────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                     │
        ▼                                     ▼
┌───────────────┐                    ┌───────────────┐
│   ADMIN       │                    │   ORGANIZADOR │
│   Criação     │                    │   Cadastro    │
└───────────────┘                    └───────────────┘
        │                                     │
        │                                     ▼
        │                           ┌─────────────────┐
        │                           │ Criar Evento   │
        │                           │ (DRAFT)         │
        │                           └─────────────────┘
        │                                     │
        │                                     ▼
        │                           ┌─────────────────┐
        │                           │ Configurar      │
        │                           │ - Modalidades  │
        │                           │ - Kits         │
        │                           │ - Perguntas    │
        │                           └─────────────────┘
        │                                     │
        │                                     ▼
        │                           ┌─────────────────┐
        │                           │ Publicar Evento │
        │                           │ (PUBLISHED)     │
        │                           └─────────────────┘
        │                                     │
        │                                     │
        ▼                                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    USUÁRIO PARTICIPA                        │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────┐
│ Buscar Eventos  │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Ver Detalhes    │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Cadastro/Login │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Selecionar      │
│ - Modalidade    │
│ - Kit           │
│ - Questionários │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Criar Inscrição │
│ (PENDING)        │
│ QR Code gerado  │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Criar Pagamento │
│ - PIX           │
│ - Cartão        │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Pagamento       │
│ Confirmado      │
│ (PAID)          │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Inscrição       │
│ CONFIRMED       │
│ Ticket válido   │
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ Dia do Evento   │
│ Validar QR Code │
│ Entrada         │
└─────────────────┘
```

---

## 🎯 6. ROLES E PERMISSÕES

### Admin (`ADMIN`)
- ✅ Gerenciar todos os usuários
- ✅ Criar/edit/deletar eventos de qualquer organizador
- ✅ Acessar todos os relatórios
- ✅ Configurar sistema
- ✅ Criar outros admins

### PodioGo Staff (`PODIOGO_STAFF`)
- ✅ Visualizar todos os eventos
- ✅ Acessar relatórios
- ✅ Suporte a usuários
- ❌ Não pode criar admins

### Organizador (`ORGANIZER`)
- ✅ Criar/edit/deletar próprios eventos
- ✅ Gerenciar modalidades e kits
- ✅ Visualizar inscrições dos seus eventos
- ✅ Acessar relatórios dos seus eventos
- ❌ Não pode gerenciar outros organizadores

### Usuário (`USER`)
- ✅ Buscar eventos
- ✅ Criar inscrições
- ✅ Visualizar próprios ingressos
- ✅ Criar perfil de organizador
- ❌ Não pode criar eventos diretamente

---

## 📝 7. ESTADOS E TRANSIÇÕES

### Status do Evento
```
DRAFT → PUBLISHED → CANCELLED
DRAFT → PUBLISHED → COMPLETED
```

### Status da Inscrição
```
PENDING → CONFIRMED → CANCELLED
PENDING → CONFIRMED → COMPLETED
PENDING → CANCELLED
```

### Status do Pagamento
```
PENDING → PAID
PENDING → FAILED
PAID → REFUNDED
```

---

## 🔐 8. SEGURANÇA E VALIDAÇÕES

### Validações de Inscrição
- ✅ Evento deve estar publicado
- ✅ Data atual entre início e fim de inscrições
- ✅ Modalidade deve estar ativa
- ✅ Vagas disponíveis na modalidade
- ✅ Estoque suficiente nos kits
- ✅ Termos e regulamento aceitos

### Validações de Pagamento
- ✅ Inscrição pertence ao usuário
- ✅ Inscrição não cancelada
- ✅ Pagamento único por inscrição
- ✅ Valor corresponde ao da inscrição

### Validações de Organizador
- ✅ Apenas organizador do evento pode editá-lo
- ✅ Não pode alterar eventos publicados (apenas cancelar)
- ✅ Validações antes de publicar evento

---

## 📧 9. NOTIFICAÇÕES E EMAILS

### Emails Enviados
1. **Cadastro de usuário** - Boas-vindas
2. **Inscrição criada** - Confirmação de inscrição pendente
3. **Pagamento pendente** - Instruções de pagamento (PIX)
4. **Pagamento confirmado** - Ticket confirmado com QR Code
5. **Inscrição de convidado** - Link para ativar conta
6. **Contato organizador** - Mensagem enviada ao organizador

---

## 🚀 10. PRÓXIMOS PASSOS RECOMENDADOS

### Funcionalidades Futuras
- [ ] Sistema de cupons de desconto
- [ ] Programa de fidelidade
- [ ] Integração com WhatsApp para notificações
- [ ] App mobile para validação de QR Codes
- [ ] Dashboard de analytics para organizadores
- [ ] Sistema de avaliação de eventos
- [ ] Compartilhamento social automático
- [ ] Lembretes de eventos (email/push)

---

## 📚 Referências

- Documentação da API: `http://localhost:3333/api`
- Swagger UI: `http://localhost:3333/api`
- Prisma Studio: `pnpm db:studio`

