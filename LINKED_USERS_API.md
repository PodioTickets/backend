# API de Usuários Vinculados

Este documento descreve a API para gerenciar usuários vinculados ao perfil do usuário principal. Usuários vinculados são perfis adicionais que podem ser usados para inscrições em eventos (ex: familiares, dependentes).

## Endpoint: GET /api/v1/user/linked-users

Retorna todos os usuários vinculados ao perfil do usuário autenticado, incluindo o próprio usuário principal.

### Autenticação

Requer autenticação via JWT token no header:
```
Authorization: Bearer <access_token>
```

### Resposta de Sucesso

**Status Code:** `200 OK`

**Body:**
```json
{
  "success": true,
  "data": {
    "users": [
      {
        "id": "user-uuid-1",
        "firstName": "João",
        "lastName": "Silva",
        "email": "joao@example.com",
        "documentNumber": "12345678900",
        "phone": "(11) 99999-9999",
        "dateOfBirth": "1990-01-15",
        "gender": "masculino",
        "isMainUser": true
      },
      {
        "id": "user-uuid-2",
        "firstName": "Maria",
        "lastName": "Silva",
        "email": "maria@example.com",
        "documentNumber": "98765432100",
        "phone": "(11) 88888-8888",
        "dateOfBirth": "1992-05-20",
        "gender": "feminino",
        "isMainUser": false
      }
    ]
  }
}
```

### Campos da Resposta

- `id` (string, obrigatório): UUID do usuário
- `firstName` (string, obrigatório): Primeiro nome do usuário
- `lastName` (string, obrigatório): Sobrenome do usuário
- `email` (string, obrigatório): Email do usuário
- `documentNumber` (string, obrigatório): CPF do usuário (apenas números)
- `phone` (string, obrigatório): Telefone do usuário (formato: (XX) XXXXX-XXXX)
- `dateOfBirth` (string, obrigatório): Data de nascimento no formato ISO 8601 (YYYY-MM-DD)
- `gender` (string, obrigatório): Gênero do usuário (valores: "masculino", "feminino", "outro", "prefiro-nao-dizer")
- `isMainUser` (boolean, opcional): Indica se é o usuário principal (true) ou um usuário vinculado (false). Se não informado, assume-se false.

### Resposta de Erro

**Status Code:** `401 Unauthorized`

```json
{
  "success": false,
  "error": "Token inválido ou expirado",
  "message": "Unauthorized"
}
```

**Status Code:** `500 Internal Server Error`

```json
{
  "success": false,
  "error": "Erro ao buscar usuários vinculados",
  "message": "Internal server error"
}
```

## Estrutura de Dados no Banco

### Tabela: `users`

A tabela de usuários deve ter os seguintes campos relevantes:

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(255) NOT NULL,
  last_name VARCHAR(255) NOT NULL,
  document_number VARCHAR(14) UNIQUE NOT NULL,
  phone VARCHAR(20),
  date_of_birth DATE,
  gender VARCHAR(50),
  -- outros campos...
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Tabela: `linked_users` (Opcional - se usar tabela separada)

Se optar por uma tabela separada para relacionar usuários:

```sql
CREATE TABLE linked_users (
  id UUID PRIMARY KEY,
  main_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship_type VARCHAR(50), -- ex: "dependente", "familiar", "outro"
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(main_user_id, linked_user_id)
);
```

## Lógica de Implementação

### Opção 1: Usuário Principal + Tabela de Relacionamento

1. O usuário autenticado é sempre incluído na lista com `isMainUser: true`
2. Buscar todos os usuários vinculados através da tabela `linked_users` onde `main_user_id = user.id`
3. Retornar o usuário principal + todos os vinculados

**Exemplo de query (Prisma):**
```typescript
const mainUser = await prisma.user.findUnique({
  where: { id: userId }
});

const linkedUsers = await prisma.linkedUser.findMany({
  where: { mainUserId: userId },
  include: { linkedUser: true }
});

const users = [
  { ...mainUser, isMainUser: true },
  ...linkedUsers.map(lu => ({ ...lu.linkedUser, isMainUser: false }))
];
```

### Opção 2: Todos os Usuários do Mesmo Grupo/Família

Se o sistema usar um conceito de "grupo familiar" ou "conta principal":

1. Identificar o grupo/família do usuário autenticado
2. Retornar todos os usuários do mesmo grupo
3. Marcar o usuário autenticado com `isMainUser: true`

**Exemplo de query (Prisma):**
```typescript
const user = await prisma.user.findUnique({
  where: { id: userId },
  include: { familyGroup: { include: { users: true } } }
});

const users = user.familyGroup.users.map(u => ({
  ...u,
  isMainUser: u.id === userId
}));
```

### Opção 3: Usuários Criados pelo Usuário Principal

Se usuários vinculados são criados pelo usuário principal:

1. Buscar o usuário principal
2. Buscar todos os usuários onde `createdByUserId = user.id` ou similar
3. Retornar o usuário principal + todos os criados por ele

**Exemplo de query (Prisma):**
```typescript
const mainUser = await prisma.user.findUnique({
  where: { id: userId }
});

const linkedUsers = await prisma.user.findMany({
  where: { createdByUserId: userId }
});

const users = [
  { ...mainUser, isMainUser: true },
  ...linkedUsers.map(u => ({ ...u, isMainUser: false }))
];
```

## Ordenação

A lista deve ser ordenada da seguinte forma:
1. Usuário principal primeiro (`isMainUser: true`)
2. Usuários vinculados ordenados alfabeticamente por nome completo

## Cache

Recomenda-se implementar cache para esta endpoint, pois os dados não mudam frequentemente:
- Cache de 5 minutos no frontend
- Cache de 1-2 minutos no backend (opcional)

## Segurança

- ✅ Apenas usuários autenticados podem acessar
- ✅ Usuários só podem ver seus próprios usuários vinculados
- ✅ Validar que o `main_user_id` corresponde ao usuário autenticado
- ✅ Não retornar informações sensíveis desnecessárias (ex: senha, tokens)

## Exemplo de Implementação (NestJS)

```typescript
@Get('linked-users')
@UseGuards(JwtAuthGuard)
async getLinkedUsers(@CurrentUser() user: User) {
  // Buscar usuário principal
  const mainUser = await this.usersService.findOne(user.id);
  
  // Buscar usuários vinculados
  const linkedUsers = await this.linkedUsersService.findByMainUserId(user.id);
  
  // Montar resposta
  const users = [
    {
      id: mainUser.id,
      firstName: mainUser.firstName,
      lastName: mainUser.lastName,
      email: mainUser.email,
      documentNumber: mainUser.documentNumber,
      phone: mainUser.phone,
      dateOfBirth: mainUser.dateOfBirth,
      gender: mainUser.gender,
      isMainUser: true,
    },
    ...linkedUsers.map(linked => ({
      id: linked.linkedUser.id,
      firstName: linked.linkedUser.firstName,
      lastName: linked.linkedUser.lastName,
      email: linked.linkedUser.email,
      documentNumber: linked.linkedUser.documentNumber,
      phone: linked.linkedUser.phone,
      dateOfBirth: linked.linkedUser.dateOfBirth,
      gender: linked.linkedUser.gender,
      isMainUser: false,
    })),
  ];
  
  // Ordenar: principal primeiro, depois alfabeticamente
  users.sort((a, b) => {
    if (a.isMainUser) return -1;
    if (b.isMainUser) return 1;
    const nameA = `${a.firstName} ${a.lastName}`.toLowerCase();
    const nameB = `${b.firstName} ${b.lastName}`.toLowerCase();
    return nameA.localeCompare(nameB);
  });
  
  return {
    success: true,
    data: { users },
  };
}
```

## Endpoint: POST /api/v1/user/linked-users

Cria um novo usuário ou vincula um usuário existente ao perfil do usuário autenticado. Este endpoint é usado quando o usuário preenche manualmente os dados de um participante no checkout.

### Autenticação

Requer autenticação via JWT token no header:
```
Authorization: Bearer <access_token>
```

### Body da Requisição

```json
{
  "firstName": "Maria",
  "lastName": "Silva",
  "email": "maria@example.com",
  "documentNumber": "98765432100",
  "phone": "11988888888",
  "dateOfBirth": "1992-05-20",
  "gender": "feminino"
}
```

### Campos da Requisição

- `firstName` (string, obrigatório): Primeiro nome do usuário
- `lastName` (string, obrigatório): Sobrenome do usuário
- `email` (string, obrigatório): Email do usuário
- `documentNumber` (string, obrigatório): CPF do usuário (apenas números, sem formatação)
- `phone` (string, obrigatório): Telefone do usuário (apenas números, sem formatação)
- `dateOfBirth` (string, obrigatório): Data de nascimento no formato ISO 8601 (YYYY-MM-DD)
- `gender` (string, obrigatório): Gênero do usuário (valores: "masculino", "feminino", "outro", "prefiro-nao-dizer")

### Lógica de Funcionamento

O backend deve seguir esta lógica:

1. **Verificar se já existe usuário com o CPF informado:**
   - Se existir → Vincular ao usuário principal (criar registro em `linked_users`)
   - Se não existir → Criar novo usuário e vincular

2. **Verificar se já existe usuário com o email informado:**
   - Se existir e for diferente do CPF → Retornar erro (email já cadastrado para outro CPF)
   - Se não existir → Prosseguir

3. **Ao criar novo usuário:**
   - Gerar senha aleatória (usuários criados via checkout não podem fazer login tradicional)
   - Criar registro na tabela `users`
   - Vincular automaticamente ao usuário principal

4. **Ao vincular usuário existente:**
   - Verificar se já está vinculado (evitar duplicação)
   - Se não estiver vinculado, criar registro em `linked_users`

### Resposta de Sucesso

**Status Code:** `200 OK` ou `201 Created`

**Body:**
```json
{
  "success": true,
  "data": {
    "id": "user-uuid-2",
    "firstName": "Maria",
    "lastName": "Silva",
    "email": "maria@example.com",
    "documentNumber": "98765432100",
    "phone": "11988888888",
    "dateOfBirth": "1992-05-20",
    "gender": "feminino",
    "wasCreated": true,
    "wasLinked": true
  }
}
```

### Campos da Resposta

- `id` (string, obrigatório): UUID do usuário (criado ou existente)
- `firstName` (string, obrigatório): Primeiro nome
- `lastName` (string, obrigatório): Sobrenome
- `email` (string, obrigatório): Email
- `documentNumber` (string, obrigatório): CPF (apenas números)
- `phone` (string, obrigatório): Telefone (apenas números)
- `dateOfBirth` (string, obrigatório): Data de nascimento (YYYY-MM-DD)
- `gender` (string, obrigatório): Gênero
- `wasCreated` (boolean, obrigatório): Indica se o usuário foi criado (true) ou já existia (false)
- `wasLinked` (boolean, obrigatório): Indica se o vínculo foi criado (true) ou já existia (false)

### Respostas de Erro

**Status Code:** `400 Bad Request` - Dados inválidos

```json
{
  "success": false,
  "error": "CPF inválido",
  "message": "O CPF informado não é válido"
}
```

**Status Code:** `409 Conflict` - Email já cadastrado para outro CPF

```json
{
  "success": false,
  "error": "Email já cadastrado",
  "message": "Este email já está cadastrado para outro CPF"
}
```

**Status Code:** `401 Unauthorized`

```json
{
  "success": false,
  "error": "Token inválido ou expirado",
  "message": "Unauthorized"
}
```

### Exemplo de Implementação (NestJS)

```typescript
@Post('linked-users')
@UseGuards(JwtAuthGuard)
async createOrLinkUser(
  @CurrentUser() mainUser: User,
  @Body() createUserDto: CreateLinkedUserDto
) {
  // 1. Verificar se usuário já existe pelo CPF
  let existingUser = await this.usersService.findByDocumentNumber(
    createUserDto.documentNumber
  );

  let wasCreated = false;
  let wasLinked = false;

  if (!existingUser) {
    // 2. Verificar se email já está em uso
    const userWithEmail = await this.usersService.findByEmail(
      createUserDto.email
    );
    
    if (userWithEmail) {
      throw new ConflictException(
        'Este email já está cadastrado para outro CPF'
      );
    }

    // 3. Criar novo usuário
    const randomPassword = crypto.randomBytes(16).toString('hex');
    
    existingUser = await this.usersService.create({
      ...createUserDto,
      password: randomPassword, // Senha aleatória (não pode fazer login)
      // outros campos necessários...
    });

    wasCreated = true;
  }

  // 4. Verificar se já está vinculado
  const existingLink = await this.linkedUsersService.findLink(
    mainUser.id,
    existingUser.id
  );

  if (!existingLink) {
    // 5. Criar vínculo
    await this.linkedUsersService.create({
      mainUserId: mainUser.id,
      linkedUserId: existingUser.id,
      relationshipType: 'outro', // ou outro tipo
    });

    wasLinked = true;
  }

  return {
    success: true,
    data: {
      id: existingUser.id,
      firstName: existingUser.firstName,
      lastName: existingUser.lastName,
      email: existingUser.email,
      documentNumber: existingUser.documentNumber,
      phone: existingUser.phone,
      dateOfBirth: existingUser.dateOfBirth,
      gender: existingUser.gender,
      wasCreated,
      wasLinked: wasLinked || !!existingLink,
    },
  };
}
```

### Validações Necessárias

- ✅ Validar formato do CPF (11 dígitos)
- ✅ Validar formato do email
- ✅ Validar formato da data de nascimento (YYYY-MM-DD)
- ✅ Validar que a data de nascimento não é futura
- ✅ Validar formato do telefone (mínimo 10 dígitos)
- ✅ Validar que o gênero está nos valores permitidos
- ✅ Verificar se CPF já existe (para decidir criar ou vincular)
- ✅ Verificar se email já existe para outro CPF (retornar erro)
- ✅ Verificar se já está vinculado (evitar duplicação)

### Notas Importantes

- Usuários criados via este endpoint recebem uma senha aleatória e **não podem fazer login tradicional**
- O vínculo é sempre criado com o usuário autenticado como `main_user_id`
- Se o usuário já estiver vinculado, a resposta deve indicar `wasLinked: true` e `wasCreated: false`
- O campo `phone` deve ser recebido sem formatação (apenas números)
- O campo `documentNumber` deve ser recebido sem formatação (apenas números)

## Notas Adicionais

- O campo `documentNumber` deve ser retornado sem formatação (apenas números)
- O campo `phone` pode ser retornado com ou sem formatação, mas o frontend espera formato: `(XX) XXXXX-XXXX`
- O campo `dateOfBirth` deve estar no formato ISO 8601: `YYYY-MM-DD`
- O campo `gender` deve usar os valores exatos: "masculino", "feminino", "outro", "prefiro-nao-dizer"

