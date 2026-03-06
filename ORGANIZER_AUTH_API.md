# Documentação de Autenticação para Organizadores

## Visão Geral

O sistema PodioTickets suporta dois tipos de contas:
- **USER**: Conta de participante (usuário normal que compra ingressos)
- **ORGANIZER**: Conta de organizador (criador e gerenciador de eventos)

**Importante**: O mesmo email pode ser usado tanto para uma conta USER quanto para uma conta ORGANIZER. São contas completamente separadas no sistema.

## Diferenças Principais

### Conta USER (Participante)
- Usada para comprar ingressos e participar de eventos
- Criada através do endpoint `/api/v1/auth/register`
- Login através de `/api/v1/auth/login` (padrão) ou `/api/v1/auth/login` com `accountType: "USER"`
- Google OAuth sempre cria contas do tipo USER

### Conta ORGANIZER (Organizador)
- Usada para criar e gerenciar eventos
- Criada através de endpoints de organização (quando um organizador é adicionado a uma organização)
- Login através de `/api/v1/auth/login/organizer` ou `/api/v1/auth/login` com `accountType: "ORGANIZER"`
- Não suporta Google OAuth (apenas login com email/senha)

## Endpoints de Autenticação

### 1. Login como Organizador

**Endpoint**: `POST /api/v1/auth/login/organizer`

**Descrição**: Endpoint dedicado para login de organizadores. Valida automaticamente como `accountType: "ORGANIZER"`.

**Request Body**:
```json
{
  "emailOrCpf": "organizer@example.com",
  "password": "senha123"
}
```

**Parâmetros**:
- `emailOrCpf` (string, obrigatório): Email ou CPF do organizador
- `password` (string, obrigatório): Senha do organizador

**Response (200 OK)**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "uuid-do-usuario",
    "email": "organizer@example.com",
    "firstName": "João",
    "lastName": "Silva",
    "accountType": "ORGANIZER",
    "role": "USER",
    "phone": "+5511999999999",
    "dateOfBirth": "1990-01-01T00:00:00.000Z",
    "gender": "MALE",
    "language": "PT",
    "avatarUrl": null
  },
  "expires_in": 3600
}
```

**Response (401 Unauthorized)**:
```json
{
  "statusCode": 401,
  "message": "Invalid credentials",
  "error": "Unauthorized"
}
```

**Exemplo de Requisição (cURL)**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login/organizer \
  -H "Content-Type: application/json" \
  -d '{
    "emailOrCpf": "organizer@example.com",
    "password": "senha123"
  }'
```

**Exemplo de Requisição (JavaScript/Fetch)**:
```javascript
const response = await fetch('http://localhost:3000/api/v1/auth/login/organizer', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    emailOrCpf: 'organizer@example.com',
    password: 'senha123'
  })
});

const data = await response.json();
if (response.ok) {
  console.log('Token:', data.access_token);
  // Armazenar token para uso em requisições autenticadas
  localStorage.setItem('access_token', data.access_token);
  localStorage.setItem('refresh_token', data.refresh_token);
} else {
  console.error('Erro no login:', data.message);
}
```

---

### 2. Login Genérico (com accountType)

**Endpoint**: `POST /api/v1/auth/login`

**Descrição**: Endpoint genérico que aceita `accountType` no body. Pode ser usado tanto para USER quanto para ORGANIZER.

**Request Body**:
```json
{
  "emailOrCpf": "organizer@example.com",
  "password": "senha123",
  "accountType": "ORGANIZER"
}
```

**Parâmetros**:
- `emailOrCpf` (string, obrigatório): Email ou CPF do usuário
- `password` (string, obrigatório): Senha do usuário
- `accountType` (string, opcional): `"USER"` ou `"ORGANIZER"`. Se não fornecido, assume `"USER"` por padrão

**Response**: Mesmo formato do endpoint `/login/organizer`

**Exemplo de Requisição**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "emailOrCpf": "organizer@example.com",
    "password": "senha123",
    "accountType": "ORGANIZER"
  }'
```

---

### 3. Refresh Token (Organizador)

**Endpoint**: `POST /api/v1/auth/refresh`

**Descrição**: Renova o access token usando o refresh token. Funciona igual para USER e ORGANIZER.

**Request Body**:
```json
{
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (200 OK)**:
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 3600
}
```

---

### 4. Perfil do Usuário

**Endpoint**: `GET /api/v1/auth/profile`

**Descrição**: Retorna o perfil do usuário autenticado (funciona para USER e ORGANIZER).

**Headers**:
```
Authorization: Bearer {access_token}
```

**Response (200 OK)**:
```json
{
  "data": {
    "id": "uuid-do-usuario",
    "email": "organizer@example.com",
    "firstName": "João",
    "lastName": "Silva",
    "accountType": "ORGANIZER",
    "role": "USER",
    "phone": "+5511999999999",
    "dateOfBirth": "1990-01-01T00:00:00.000Z",
    "gender": "MALE",
    "language": "PT",
    "avatarUrl": null
  },
  "message": "User profile",
  "success": true
}
```

---

## Recuperação de Senha para Organizadores

### 1. Solicitar Código de Recuperação

**Endpoint**: `POST /api/v1/auth/forgot-password`

**Request Body**:
```json
{
  "email": "organizer@example.com",
  "accountType": "ORGANIZER"
}
```

**Parâmetros**:
- `email` (string, obrigatório): Email do organizador
- `accountType` (string, opcional): `"USER"` ou `"ORGANIZER"`. Se não fornecido, assume `"USER"` por padrão

**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Se uma conta existir com este email, um código de recuperação foi enviado"
}
```

**Nota**: Em desenvolvimento, o código de 6 dígitos é exibido no console do servidor. Em produção, será enviado por email.

**Exemplo de Requisição**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/forgot-password \
  -H "Content-Type: application/json" \
  -d '{
    "email": "organizer@example.com",
    "accountType": "ORGANIZER"
  }'
```

---

### 2. Verificar Código de Recuperação

**Endpoint**: `POST /api/v1/auth/verify-reset-code`

**Request Body**:
```json
{
  "email": "organizer@example.com",
  "code": "123456",
  "accountType": "ORGANIZER"
}
```

**Parâmetros**:
- `email` (string, obrigatório): Email do organizador
- `code` (string, obrigatório): Código de 6 dígitos recebido
- `accountType` (string, opcional): `"USER"` ou `"ORGANIZER"`. Se não fornecido, assume `"USER"` por padrão

**Response (200 OK)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "message": "Código verificado com sucesso"
}
```

**Response (400 Bad Request)**:
```json
{
  "statusCode": 400,
  "message": "Código inválido ou expirado",
  "error": "Bad Request"
}
```

**Exemplo de Requisição**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/verify-reset-code \
  -H "Content-Type: application/json" \
  -d '{
    "email": "organizer@example.com",
    "code": "123456",
    "accountType": "ORGANIZER"
  }'
```

---

### 3. Reenviar Código de Recuperação

**Endpoint**: `POST /api/v1/auth/resend-reset-code`

**Request Body**:
```json
{
  "email": "organizer@example.com",
  "accountType": "ORGANIZER"
}
```

**Parâmetros**:
- `email` (string, obrigatório): Email do organizador
- `accountType` (string, opcional): `"USER"` ou `"ORGANIZER"`. Se não fornecido, assume `"USER"` por padrão

**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Código reenviado com sucesso"
}
```

**Response (429 Too Many Requests)**:
```json
{
  "statusCode": 429,
  "message": "Aguarde antes de solicitar um novo código",
  "error": "Bad Request"
}
```

**Nota**: Rate limit de 1 reenvio por minuto.

---

### 4. Redefinir Senha

**Endpoint**: `POST /api/v1/auth/reset-password`

**Request Body**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "password": "NovaSenha123"
}
```

**Parâmetros**:
- `token` (string, obrigatório): Token JWT recebido após verificar o código
- `password` (string, obrigatório): Nova senha (mínimo 8 caracteres, deve conter pelo menos uma letra maiúscula, uma minúscula e um número)

**Response (200 OK)**:
```json
{
  "success": true,
  "message": "Senha redefinida com sucesso"
}
```

**Response (400 Bad Request)**:
```json
{
  "statusCode": 400,
  "message": "Token inválido ou expirado",
  "error": "Bad Request"
}
```

**Exemplo de Requisição**:
```bash
curl -X POST http://localhost:3000/api/v1/auth/reset-password \
  -H "Content-Type: application/json" \
  -d '{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "password": "NovaSenha123"
  }'
```

---

## Estrutura do JWT Token

O token JWT contém as seguintes informações no payload:

```json
{
  "sub": "uuid-do-usuario",
  "email": "organizer@example.com",
  "accountType": "ORGANIZER",
  "role": "USER",
  "iat": 1234567890,
  "exp": 1234571490
}
```

**Campos importantes**:
- `sub`: ID do usuário
- `email`: Email do usuário
- `accountType`: Tipo de conta (`"USER"` ou `"ORGANIZER"`)
- `role`: Papel do usuário no sistema (geralmente `"USER"`, mas pode ser `"ADMIN"`)
- `iat`: Timestamp de emissão
- `exp`: Timestamp de expiração

**Token de Reset de Senha**:
```json
{
  "email": "organizer@example.com",
  "accountType": "ORGANIZER",
  "userId": "uuid-do-usuario",
  "type": "password_reset",
  "iat": 1234567890,
  "exp": 1234571490
}
```

---

## Fluxo Completo de Autenticação

### Fluxo de Login

```
1. Cliente → POST /api/v1/auth/login/organizer
   Body: { emailOrCpf, password }
   
2. Servidor valida credenciais (accountType: "ORGANIZER")
   
3. Servidor → Cliente
   Response: { access_token, refresh_token, user, expires_in }
   
4. Cliente armazena tokens
   
5. Cliente usa access_token em requisições autenticadas
   Header: Authorization: Bearer {access_token}
```

### Fluxo de Recuperação de Senha

```
1. Cliente → POST /api/v1/auth/forgot-password
   Body: { email, accountType: "ORGANIZER" }
   
2. Servidor gera código de 6 dígitos e armazena no cache
   
3. Servidor → Cliente
   Response: { success: true, message: "..." }
   
4. Cliente recebe código (email ou console em dev)
   
5. Cliente → POST /api/v1/auth/verify-reset-code
   Body: { email, code, accountType: "ORGANIZER" }
   
6. Servidor valida código e gera token JWT de reset
   
7. Servidor → Cliente
   Response: { success: true, token: "..." }
   
8. Cliente → POST /api/v1/auth/reset-password
   Body: { token, password }
   
9. Servidor valida token e atualiza senha
   
10. Servidor → Cliente
    Response: { success: true, message: "Senha redefinida com sucesso" }
```

---

## Exemplo de Implementação Completa

### JavaScript/TypeScript (Frontend)

```typescript
class OrganizerAuthService {
  private baseUrl = 'http://localhost:3000/api/v1/auth';

  async login(emailOrCpf: string, password: string) {
    const response = await fetch(`${this.baseUrl}/login/organizer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ emailOrCpf, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro no login');
    }

    const data = await response.json();
    
    // Armazenar tokens
    localStorage.setItem('access_token', data.access_token);
    localStorage.setItem('refresh_token', data.refresh_token);
    localStorage.setItem('user', JSON.stringify(data.user));
    
    return data;
  }

  async forgotPassword(email: string) {
    const response = await fetch(`${this.baseUrl}/forgot-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        email, 
        accountType: 'ORGANIZER' 
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro ao solicitar código');
    }

    return await response.json();
  }

  async verifyResetCode(email: string, code: string) {
    const response = await fetch(`${this.baseUrl}/verify-reset-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        email, 
        code, 
        accountType: 'ORGANIZER' 
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Código inválido');
    }

    const data = await response.json();
    localStorage.setItem('reset_token', data.token);
    return data;
  }

  async resetPassword(password: string) {
    const token = localStorage.getItem('reset_token');
    if (!token) {
      throw new Error('Token de reset não encontrado');
    }

    const response = await fetch(`${this.baseUrl}/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, password }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro ao redefinir senha');
    }

    localStorage.removeItem('reset_token');
    return await response.json();
  }

  async getProfile() {
    const token = localStorage.getItem('access_token');
    if (!token) {
      throw new Error('Token não encontrado');
    }

    const response = await fetch(`${this.baseUrl}/profile`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro ao buscar perfil');
    }

    return await response.json();
  }

  async refreshToken() {
    const refreshToken = localStorage.getItem('refresh_token');
    if (!refreshToken) {
      throw new Error('Refresh token não encontrado');
    }

    const response = await fetch(`${this.baseUrl}/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Erro ao renovar token');
    }

    const data = await response.json();
    localStorage.setItem('access_token', data.access_token);
    localStorage.setItem('refresh_token', data.refresh_token);
    return data;
  }

  logout() {
    localStorage.removeItem('access_token');
    localStorage.removeItem('refresh_token');
    localStorage.removeItem('user');
    localStorage.removeItem('reset_token');
  }

  isAuthenticated(): boolean {
    return !!localStorage.getItem('access_token');
  }

  getAccessToken(): string | null {
    return localStorage.getItem('access_token');
  }
}

// Uso
const authService = new OrganizerAuthService();

// Login
try {
  const result = await authService.login('organizer@example.com', 'senha123');
  console.log('Login realizado com sucesso:', result);
} catch (error) {
  console.error('Erro no login:', error.message);
}

// Recuperação de senha
try {
  await authService.forgotPassword('organizer@example.com');
  // Código será exibido no console do servidor (dev) ou enviado por email (prod)
  
  // Usuário insere código recebido
  const code = '123456';
  await authService.verifyResetCode('organizer@example.com', code);
  
  // Usuário define nova senha
  await authService.resetPassword('NovaSenha123');
  console.log('Senha redefinida com sucesso!');
} catch (error) {
  console.error('Erro na recuperação:', error.message);
}
```

---

## Criação de Conta de Organizador

As contas de organizador não são criadas através do endpoint `/api/v1/auth/register`. Elas são criadas quando:

1. Uma organização é criada e um usuário é definido como owner
2. Um membro é adicionado a uma organização como admin ou membro

O sistema automaticamente cria uma conta com `accountType: "ORGANIZER"` quando necessário.

**Exemplo**: Quando você adiciona um membro a uma organização através do endpoint de organizações, se o email não existir como ORGANIZER, o sistema cria automaticamente uma conta ORGANIZER.

---

## Segurança e Boas Práticas

1. **Armazenamento de Tokens**: 
   - Em aplicações web, use `localStorage` ou `sessionStorage`
   - Em aplicações mobile, use armazenamento seguro (Keychain/Keystore)
   - Nunca armazene tokens em cookies não seguros

2. **Renovação de Token**:
   - Monitore a expiração do `access_token`
   - Use o `refresh_token` para renovar antes que expire
   - Implemente retry automático em caso de token expirado

3. **Validação de Senha**:
   - Mínimo 8 caracteres
   - Pelo menos uma letra maiúscula
   - Pelo menos uma letra minúscula
   - Pelo menos um número

4. **Rate Limiting**:
   - O sistema limita reenvios de código (1 por minuto)
   - Limita tentativas de verificação de código (5 tentativas)

5. **HTTPS**:
   - Sempre use HTTPS em produção
   - Nunca envie tokens ou senhas em requisições HTTP

---

## Tratamento de Erros

### Erros Comuns

**401 Unauthorized**:
- Credenciais inválidas
- Token expirado ou inválido
- Usuário inativo

**400 Bad Request**:
- Dados de entrada inválidos
- Código de reset inválido ou expirado
- Senha não atende aos requisitos

**429 Too Many Requests**:
- Muitas tentativas de reenvio de código
- Rate limit excedido

**404 Not Found**:
- Endpoint não encontrado
- Recurso não existe

### Exemplo de Tratamento

```typescript
try {
  await authService.login(email, password);
} catch (error) {
  if (error.response?.status === 401) {
    // Credenciais inválidas
    showError('Email ou senha incorretos');
  } else if (error.response?.status === 400) {
    // Dados inválidos
    showError('Por favor, verifique os dados informados');
  } else {
    // Erro genérico
    showError('Erro ao fazer login. Tente novamente.');
  }
}
```

---

## Notas Importantes

1. **Mesmo Email**: O mesmo email pode ter uma conta USER e uma conta ORGANIZER. São contas completamente separadas.

2. **Google OAuth**: Google OAuth sempre cria contas do tipo USER. Organizadores não podem fazer login com Google.

3. **Token Expiração**: 
   - `access_token`: 1 hora (3600 segundos)
   - `refresh_token`: 7 dias (configurável via `JWT_REFRESH_EXPIRES_IN`)

4. **Código de Reset**: 
   - Válido por 15 minutos
   - Pode ser usado apenas uma vez
   - Máximo de 5 tentativas de verificação

5. **Desenvolvimento vs Produção**:
   - Em desenvolvimento, códigos de reset aparecem no console do servidor
   - Em produção, códigos serão enviados por email (quando implementado)

---

## Suporte

Para dúvidas ou problemas:
- Verifique os logs do servidor para códigos de reset em desenvolvimento
- Confirme que está usando o `accountType` correto nas requisições
- Verifique se o email existe como ORGANIZER no banco de dados
- Certifique-se de que o token está sendo enviado corretamente no header `Authorization`

---

**Última atualização**: 05/03/2026
