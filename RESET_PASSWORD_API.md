# Documentação da API - Recuperação de Senha (Usuário e Organizador)

Esta documentação descreve os endpoints necessários para o fluxo completo de recuperação de senha para usuários normais (participantes) e organizadores.

## Visão Geral

O fluxo de recuperação de senha consiste em 4 etapas:
1. Usuário solicita código de recuperação via email
2. Usuário verifica o código recebido e obtém um token
3. Usuário redefine a senha usando o token
4. Sistema confirma a redefinição

Todos os endpoints estão sob o prefixo `/api/v1/auth/`.

## Fluxo Completo

1. **Step 1**: Usuário informa o email → Envia código de recuperação
2. **Step 2**: Usuário informa o código recebido → Verifica código e retorna token
3. **Step 3**: Usuário cria nova senha com o token → Redefine a senha
4. **Conclusão**: Tela de sucesso

---

## 1. Solicitar Código de Recuperação

Envia um código de 6 dígitos para o email do organizador.

### Endpoint

```
POST /api/v1/auth/forgot-password
```

### Request Body

```json
{
  "email": "organizador@example.com"
}
```

### Response (Sucesso)

```json
{
  "success": true,
  "message": "Código de recuperação enviado com sucesso"
}
```

### Response (Erro)

```json
{
  "success": false,
  "message": "Email não encontrado"
}
```

### Status Codes

- `200` - Código enviado com sucesso
- `404` - Email não encontrado
- `400` - Email inválido
- `500` - Erro interno do servidor

### Comportamento Esperado

- O servidor deve gerar um código de 6 dígitos
- O código deve ser enviado por email
- O código deve ter um tempo de expiração (recomendado: 10-15 minutos)
- O código deve ser armazenado associado ao email para validação posterior

---

## 2. Verificar Código de Recuperação

Verifica se o código informado pelo usuário é válido e retorna um token para redefinição de senha.

### Endpoint

```
POST /api/v1/auth/verify-reset-code
```

### Request Body

```json
{
  "email": "usuario@example.com",
  "code": "123456",
  "accountType": "USER"
}
```

ou

```json
{
  "email": "organizador@example.com",
  "code": "123456",
  "accountType": "ORGANIZER"
}
```

**Parâmetros:**
- `email` (obrigatório): Email do usuário ou organizador
- `code` (obrigatório): Código de 6 dígitos recebido por email
- `accountType` (opcional): Tipo de conta - `USER` (padrão) ou `ORGANIZER`

### Response (Sucesso)

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "message": "Código verificado com sucesso"
}
```

### Response (Erro - Código Inválido)

```json
{
  "success": false,
  "message": "Código inválido ou expirado"
}
```

### Status Codes

- `200` - Código verificado com sucesso
- `400` - Código inválido ou expirado
- `404` - Email não encontrado
- `429` - Muitas tentativas (rate limiting)
- `500` - Erro interno do servidor

### Comportamento Esperado

- Validar se o código existe e está associado ao email
- Verificar se o código não expirou
- Verificar se o código não foi usado anteriormente
- Gerar um token JWT ou similar com tempo de expiração (recomendado: 15-30 minutos)
- O token deve ser único e associado ao email
- Após verificação bem-sucedida, invalidar o código para evitar reutilização

---

## 3. Reenviar Código de Recuperação

Reenvia um novo código de recuperação para o email do usuário ou organizador.

### Endpoint

```
POST /api/v1/auth/resend-reset-code
```

### Request Body

```json
{
  "email": "usuario@example.com",
  "accountType": "USER"
}
```

ou

```json
{
  "email": "organizador@example.com",
  "accountType": "ORGANIZER"
}
```

**Parâmetros:**
- `email` (obrigatório): Email do usuário ou organizador
- `accountType` (opcional): Tipo de conta - `USER` (padrão) ou `ORGANIZER`

### Response (Sucesso)

```json
{
  "success": true,
  "message": "Código reenviado com sucesso"
}
```

### Response (Erro)

```json
{
  "success": false,
  "message": "Aguarde antes de solicitar um novo código"
}
```

### Status Codes

- `200` - Código reenviado com sucesso
- `429` - Rate limit (recomendado: máximo 1 reenvio por minuto)
- `404` - Email não encontrado
- `500` - Erro interno do servidor

### Comportamento Esperado

- Validar rate limiting (recomendado: máximo 1 reenvio por minuto)
- Invalidar o código anterior se existir
- Gerar um novo código de 6 dígitos
- Enviar o novo código por email
- Atualizar o tempo de expiração

---

## 4. Redefinir Senha

Redefine a senha do usuário ou organizador usando o token obtido na verificação do código. O token já contém a informação do `accountType`, então não é necessário enviá-lo novamente.

### Endpoint

```
POST /api/v1/auth/reset-password
```

### Request Body

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "password": "NovaSenha123!"
}
```

### Validações de Senha

A senha deve atender aos seguintes critérios:
- Mínimo de 8 caracteres
- Pelo menos uma letra maiúscula (A-Z)
- Pelo menos uma letra minúscula (a-z)
- Pelo menos um número (0-9)

### Response (Sucesso)

```json
{
  "success": true,
  "message": "Senha redefinida com sucesso"
}
```

### Response (Erro - Token Inválido)

```json
{
  "success": false,
  "message": "Token inválido ou expirado"
}
```

### Response (Erro - Senha Inválida)

```json
{
  "success": false,
  "message": "A senha não atende aos critérios de segurança"
}
```

### Response (Erro - Senha Igual à Anterior)

```json
{
  "success": false,
  "message": "A nova senha não pode ser igual às senhas anteriores"
}
```

### Status Codes

- `200` - Senha redefinida com sucesso
- `400` - Token inválido/expirado ou senha não atende aos critérios
- `401` - Token inválido ou expirado
- `500` - Erro interno do servidor

### Comportamento Esperado

- Validar se o token é válido e não expirou
- Validar se o token está associado a um email válido
- Validar os critérios de senha forte
- Verificar se a nova senha não é igual às últimas N senhas (recomendado: últimas 3-5 senhas)
- Criptografar a nova senha antes de armazenar
- Invalidar o token após uso bem-sucedido
- Invalidar todos os tokens de recuperação pendentes para o mesmo email
- Opcionalmente, invalidar todas as sessões ativas do usuário (forçar novo login)

---

## Estrutura de Dados Esperada

### Código de Recuperação (Armazenamento)

```typescript
interface ResetCode {
  email: string;
  code: string; // 6 dígitos
  expiresAt: Date;
  used: boolean;
  attempts: number; // Tentativas de verificação
  createdAt: Date;
}
```

### Token de Recuperação (JWT Payload)

```typescript
interface ResetTokenPayload {
  email: string;
  accountType: "USER" | "ORGANIZER"; // Tipo de conta
  userId: string; // ID do usuário
  type: "password_reset";
  iat: number; // Issued at
  exp: number; // Expiration
  jti: string; // JWT ID (para invalidar tokens específicos)
}
```

---

## Segurança e Boas Práticas

### Rate Limiting

1. **Solicitar código**: Máximo 3 tentativas por hora por IP/email
2. **Reenviar código**: Máximo 1 reenvio por minuto por email
3. **Verificar código**: Máximo 5 tentativas por código antes de invalidar
4. **Redefinir senha**: Máximo 3 tentativas por token

### Expiração

1. **Código de recuperação**: 10-15 minutos
2. **Token de reset**: 15-30 minutos

### Validações

1. **Email**: Deve ser um email válido e existir no sistema
2. **Código**: Deve ser exatamente 6 dígitos numéricos
3. **Token**: Deve ser válido, não expirado e não usado
4. **Senha**: Deve atender aos critérios de segurança

### Logs e Auditoria

Recomenda-se registrar:
- Tentativas de solicitação de código
- Tentativas de verificação de código (sucesso/falha)
- Tentativas de redefinição de senha (sucesso/falha)
- IPs e timestamps de todas as operações

---

## Fluxo de Erros Comuns

### Código Inválido

```
Usuário tenta verificar código → Código inválido/expirado
→ Retorna erro 400 com mensagem "Código inválido ou expirado"
→ Frontend exibe mensagem de erro e permite reenvio após countdown
```

### Token Expirado

```
Usuário tenta redefinir senha → Token expirado
→ Retorna erro 401 com mensagem "Token inválido ou expirado"
→ Frontend redireciona para tela de recuperação de senha correspondente (USER ou ORGANIZER)
```

### Rate Limit Excedido

```
Usuário tenta reenviar código muito rápido
→ Retorna erro 429 com mensagem "Aguarde antes de solicitar um novo código"
→ Frontend exibe mensagem e mantém countdown
```

---

## Exemplo de Implementação (Pseudocódigo)

### Solicitar Código

```javascript
POST /api/v1/auth/forgot-password
{
  email: "organizador@example.com"
}

// Backend
1. Validar email
2. Verificar se email existe no sistema
3. Verificar rate limit
4. Gerar código de 6 dígitos
5. Armazenar código com expiração (15 min)
6. Enviar email com código
7. Retornar sucesso
```

### Verificar Código

```javascript
POST /api/v1/auth/verify-reset-code
{
  email: "organizador@example.com",
  code: "123456"
}

// Backend
1. Buscar código associado ao email
2. Verificar se código existe e não foi usado
3. Verificar se código não expirou
4. Verificar tentativas (máx 5)
5. Incrementar contador de tentativas
6. Se válido:
   - Marcar código como usado
   - Gerar token JWT com expiração (30 min)
   - Retornar token
7. Se inválido:
   - Retornar erro
```

### Redefinir Senha

```javascript
POST /api/v1/auth/reset-password
{
  token: "jwt_token...",
  password: "NovaSenha123!"
}

// Backend
1. Validar e decodificar token
2. Verificar se token não expirou
3. Validar senha (critérios de segurança)
4. Verificar se senha não é igual às anteriores
5. Criptografar nova senha
6. Atualizar senha no banco
7. Invalidar token e todos os tokens pendentes
8. Opcional: Invalidar sessões ativas
9. Retornar sucesso
```

---

## Notas Importantes

1. **Tokens devem ser únicos**: Cada token deve ser single-use (usado uma vez e invalidado)
2. **Códigos devem ser únicos**: Cada código deve ser single-use após verificação bem-sucedida
3. **Histórico de senhas**: Manter histórico das últimas senhas para evitar reutilização
4. **Logs de segurança**: Registrar todas as tentativas para auditoria
5. **Email**: O email de recuperação deve ser claro e incluir instruções de segurança

---

## Testes Recomendados

### Casos de Sucesso

- [ ] Solicitar código com email válido (USER)
- [ ] Solicitar código com email válido (ORGANIZER)
- [ ] Verificar código válido e receber token (USER)
- [ ] Verificar código válido e receber token (ORGANIZER)
- [ ] Redefinir senha com token válido (USER)
- [ ] Redefinir senha com token válido (ORGANIZER)
- [ ] Reenviar código após countdown
- [ ] Mesmo email pode ter contas USER e ORGANIZER separadas

### Casos de Erro

- [ ] Solicitar código com email inexistente
- [ ] Verificar código inválido
- [ ] Verificar código expirado
- [ ] Redefinir senha com token expirado
- [ ] Redefinir senha com senha fraca
- [ ] Redefinir senha igual à anterior
- [ ] Rate limit em solicitação de código
- [ ] Rate limit em reenvio de código

---

## Integração com Frontend

O frontend espera que os endpoints retornem:

1. **Sucesso**: `{ success: true, ... }` ou `{ message: "..." }`
2. **Erro**: `{ success: false, message: "..." }` ou `{ message: "..." }`

Os erros devem incluir mensagens descritivas em português para exibição ao usuário.
