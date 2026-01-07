# Login com Google OAuth

Este documento explica como configurar e usar o login com Google no sistema.

## Configuração

### 1. Criar Credenciais no Google Cloud Console

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/)
2. Crie um novo projeto ou selecione um existente
3. Vá em **APIs & Services** > **Credentials**
4. Clique em **Create Credentials** > **OAuth client ID**
5. Configure:
   - **Application type**: Web application
   - **Name**: PodioTickets (ou o nome que preferir)
   - **Authorized JavaScript origins**: 
     - `http://localhost:3000` (desenvolvimento)
     - `https://seu-dominio.com` (produção)
   - **Authorized redirect URIs**:
     - `http://localhost:3000/auth/callback` (desenvolvimento - URL do frontend)
     - `https://seu-dominio.com/auth/callback` (produção - URL do frontend)
6. Copie o **Client ID** e **Client Secret**

### 2. Configurar Variáveis de Ambiente

Adicione as seguintes variáveis no arquivo `.env`:

```env
# Google OAuth
GOOGLE_CLIENT_ID=seu-client-id-aqui
GOOGLE_CLIENT_SECRET=seu-client-secret-aqui

# Frontend URL (onde o Google redireciona após autorização)
FRONTEND_URL=http://localhost:3000
```

Para produção, ajuste as URLs conforme necessário.

### 3. Aplicar Migration

Execute a migration para adicionar os campos do Google no banco de dados:

```bash
npx prisma migrate dev
```

Ou se preferir aplicar manualmente:

```bash
npx prisma migrate deploy
```

### 4. Regenerar Prisma Client

Após aplicar a migration, regenere o Prisma Client:

```bash
npx prisma generate
```

## Como Funciona

### Fluxo de Autenticação

1. **Usuário clica em "Login com Google"** no frontend
2. **Frontend redireciona** para: `GET /api/v1/auth/google`
3. **Backend redireciona** para a tela de consentimento do Google
4. **Usuário autoriza** o acesso
5. **Google redireciona** para o frontend (URL configurada no Google Cloud Console) com código de autorização
6. **Frontend pega** o código da URL
7. **Frontend faz POST** para: `POST /api/v1/auth/google/validate` com o código
8. **Backend valida** o código com Google, obtém dados do usuário
9. **Backend cria ou encontra** o usuário no banco de dados
10. **Backend retorna** tokens JWT (access_token e refresh_token) e dados do usuário

### Endpoints

#### `GET /api/v1/auth/google`
Inicia o fluxo OAuth. Redireciona para a tela de consentimento do Google.

**Importante:** Configure o `redirect_uri` no Google Cloud Console para apontar para o frontend (ex: `http://localhost:3000/auth/callback`), não para o backend.

#### `POST /api/v1/auth/google/validate`
Valida código do Google OAuth e retorna tokens JWT.

**Body:**
```json
{
  "code": "4/0ATX87lO8nvcAqU_MVyDPWPTKOHjxuiz2uTq7EKMO1xOrdJgVumhVwIB8CPfXJiIQ1vVARQ",
  "redirectUri": "http://localhost:3000/auth/callback"
}
```

**Resposta:**
```json
{
  "message": "Login successful",
  "success": true,
  "data": {
    "access_token": "eyJhbGc...",
    "refresh_token": "eyJhbGc...",
    "user": {
      "id": "...",
      "email": "user@gmail.com",
      "firstName": "Nome",
      "lastName": "Sobrenome",
      "role": "USER",
      "avatarUrl": "https://..."
    }
  }
}
```

### Estrutura de Dados

O sistema armazena os seguintes campos relacionados ao Google:

- `googleId`: ID único do usuário no Google (único no banco)
- `googleEmail`: Email do usuário no Google

### Comportamento

1. **Primeiro login com Google**: Cria um novo usuário no sistema
2. **Login subsequente**: Encontra o usuário pelo `googleId`
3. **Email já cadastrado**: Se o email já existe no sistema, vincula a conta Google ao usuário existente
4. **Atualização automática**: Atualiza avatar e email se houver mudanças no Google

## Frontend

### Exemplo de Implementação

```typescript
// Botão de login com Google
const handleGoogleLogin = () => {
  window.location.href = 'http://localhost:3000/api/v1/auth/google';
};

// Página de callback (/auth/callback)
useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  
  if (code) {
    // Fazer POST para validar código do Google e obter tokens
    fetch('http://localhost:3333/api/v1/auth/google/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        code,
        redirectUri: window.location.origin + window.location.pathname // ex: http://localhost:3000/auth/callback
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.data && data.data.access_token) {
          // Salvar tokens no localStorage ou estado
          localStorage.setItem('access_token', data.data.access_token);
          localStorage.setItem('refresh_token', data.data.refresh_token);
          
          // Salvar dados do usuário se necessário
          if (data.data.user) {
            localStorage.setItem('user', JSON.stringify(data.data.user));
          }
          
          // Limpar código da URL
          window.history.replaceState(null, '', window.location.pathname);
          
          // Redirecionar para página principal
          window.location.href = '/';
        } else {
          window.location.href = '/auth/error?message=' + encodeURIComponent(data.message || 'Authentication failed');
        }
      })
      .catch(error => {
        console.error('Error validating Google code:', error);
        window.location.href = '/auth/error?message=' + encodeURIComponent('Failed to validate Google code');
      });
  }
}, []);
```

## Segurança

- ✅ **Tokens não aparecem na URL**: O sistema usa código temporário e POST para trocar por tokens
- ✅ **Tokens no hash**: Tokens são passados via hash (`#tokens=...`) que não aparece em logs do servidor
- ✅ **Código de uso único**: Cada código só pode ser usado uma vez e expira em 5 minutos
- ✅ **POST seguro**: Troca de código por tokens é feita via POST (não GET)
- O campo `password` é obrigatório no banco, mas usuários do Google recebem uma senha aleatória que não pode ser usada para login tradicional
- O `googleId` é único no banco, garantindo que cada conta Google seja vinculada a apenas um usuário

## Troubleshooting

### Erro: "Invalid client"
- Verifique se `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` estão corretos
- Verifique se a URL de callback está autorizada no Google Cloud Console

### Erro: "Redirect URI mismatch"
- Verifique se `GOOGLE_CALLBACK_URL` corresponde exatamente à URL configurada no Google Cloud Console
- URLs devem ser idênticas (incluindo http/https, porta, etc.)

### Erro: "User not found"
- Verifique se a migration foi aplicada corretamente
- Verifique se o Prisma Client foi regenerado após a migration

