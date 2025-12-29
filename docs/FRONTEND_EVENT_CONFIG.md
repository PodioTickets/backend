# Documentação de Configurações de Eventos - Frontend

Esta documentação descreve as APIs e estruturas de dados para gerenciar as configurações de eventos: **Modalidades**, **Kits**, **Tópicos** e **Localizações**.

## Índice

- [Modalidades](#modalidades)
- [Kits](#kits)
- [Tópicos](#tópicos)
- [Localizações](#localizações)
- [Upload de Imagens](#upload-de-imagens)

---

## Modalidades

As modalidades representam as diferentes categorias de participação em um evento (ex: "Corrida 5km", "Corrida 10km", "Caminhada").

### Estrutura de Dados

```typescript
interface Modality {
  id: string;                    // UUID
  eventId: string;               // UUID do evento
  templateId?: string;           // UUID do template (opcional)
  name: string;                  // Nome da modalidade
  description?: string;          // Descrição opcional
  price: number;                // Preço da modalidade
  maxParticipants?: number;      // Limite máximo de participantes (opcional)
  currentParticipants: number;   // Número atual de participantes
  isActive: boolean;            // Se a modalidade está ativa
  order: number;                // Ordem de exibição
  createdAt: string;            // ISO 8601 date string
  updatedAt: string;            // ISO 8601 date string
  template?: {                   // Template associado (se houver)
    id: string;
    code: string;
    label: string;
    icon?: string;
  };
}
```

### Endpoints

#### 1. Listar Templates de Modalidades

**GET** `/api/v1/modalities/templates`

Retorna todos os templates de modalidades disponíveis que podem ser usados ao criar uma modalidade.

**Resposta:**
```json
{
  "message": "Templates retrieved successfully",
  "data": {
    "templates": [
      {
        "id": "uuid",
        "code": "corrida-de-rua",
        "label": "Corrida de rua",
        "icon": "/icons/corrida.svg",
        "isActive": true
      }
    ]
  }
}
```

#### 2. Criar Modalidade

**POST** `/api/v1/modalities/events/:eventId`

**Autenticação:** Requerida (Bearer Token)

**Body:**
```json
{
  "templateId": "uuid",           // Opcional - ID do template
  "name": "Corrida 5km",
  "description": "Modalidade de corrida de 5 quilômetros",
  "price": 50.00,
  "maxParticipants": 100,        // Opcional
  "isActive": true,              // Opcional (default: true)
  "order": 0                     // Opcional (default: 0)
}
```

**Resposta (201):**
```json
{
  "message": "Modality created successfully",
  "data": {
    "modality": {
      "id": "uuid",
      "eventId": "uuid",
      "name": "Corrida 5km",
      "price": 50.00,
      "currentParticipants": 0,
      "isActive": true,
      "order": 0,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

#### 3. Listar Modalidades de um Evento

**GET** `/api/v1/modalities/events/:eventId`

Retorna todas as modalidades ativas de um evento, ordenadas por `order`.

**Resposta:**
```json
{
  "message": "Modalities retrieved successfully",
  "data": {
    "modalities": [
      {
        "id": "uuid",
        "name": "Corrida 5km",
        "price": 50.00,
        "currentParticipants": 25,
        "maxParticipants": 100,
        "isActive": true,
        "order": 0,
        "template": {
          "id": "uuid",
          "code": "corrida-de-rua",
          "label": "Corrida de rua"
        }
      }
    ]
  }
}
```

#### 4. Buscar Modalidade por ID

**GET** `/api/v1/modalities/:id`

**Resposta:**
```json
{
  "message": "Modality retrieved successfully",
  "data": {
    "modality": {
      "id": "uuid",
      "name": "Corrida 5km",
      "price": 50.00,
      "currentParticipants": 25,
      "maxParticipants": 100,
      "isActive": true
    }
  }
}
```

#### 5. Atualizar Modalidade

**PATCH** `/api/v1/modalities/events/:eventId/:modalityId`

**Autenticação:** Requerida (Bearer Token)

**Body (todos os campos são opcionais):**
```json
{
  "name": "Corrida 5km Atualizada",
  "description": "Nova descrição",
  "price": 55.00,
  "maxParticipants": 120,
  "isActive": false,
  "order": 1
}
```

#### 6. Deletar Modalidade

**DELETE** `/api/v1/modalities/events/:eventId/:modalityId`

**Autenticação:** Requerida (Bearer Token)

**Resposta (200):**
```json
{
  "message": "Modality deleted successfully"
}
```

---

## Kits

Os kits representam pacotes de itens que podem ser incluídos na inscrição do evento (ex: "Kit Básico", "Kit Premium").

### Estrutura de Dados

```typescript
interface Kit {
  id: string;                    // UUID
  eventId: string;               // UUID do evento
  name: string;                  // Nome do kit
  description?: string;          // Descrição opcional
  isActive: boolean;            // Se o kit está ativo
  createdAt: string;            // ISO 8601 date string
  updatedAt: string;            // ISO 8601 date string
  items: KitItem[];            // Itens do kit
}

interface KitItem {
  id: string;                    // UUID
  kitId: string;                // UUID do kit
  name: string;                 // Nome do item
  description?: string;         // Descrição opcional
  sizes: KitItemSize[];        // Tamanhos disponíveis
  isActive: boolean;           // Se o item está ativo
  createdAt: string;           // ISO 8601 date string
  updatedAt: string;           // ISO 8601 date string
}

interface KitItemSize {
  size: string;                 // Tamanho (ex: "P", "M", "G", "GG")
  stock: number;                // Estoque disponível
}
```

### Endpoints

#### 1. Criar Kit

**POST** `/api/v1/kits/events/:eventId`

**Autenticação:** Requerida (Bearer Token)

**Body:**
```json
{
  "name": "Kit Básico",
  "description": "Kit com camiseta e número de peito",
  "isActive": true,             // Opcional (default: true)
  "items": [                     // Opcional - pode criar itens junto
    {
      "name": "Camiseta",
      "description": "Camiseta do evento",
      "sizes": [
        { "size": "P", "stock": 50 },
        { "size": "M", "stock": 100 },
        { "size": "G", "stock": 80 },
        { "size": "GG", "stock": 30 }
      ],
      "isActive": true
    }
  ]
}
```

**Resposta (201):**
```json
{
  "message": "Kit created successfully",
  "data": {
    "kit": {
      "id": "uuid",
      "eventId": "uuid",
      "name": "Kit Básico",
      "description": "Kit com camiseta e número de peito",
      "isActive": true,
      "items": [
        {
          "id": "uuid",
          "name": "Camiseta",
          "sizes": [
            { "size": "P", "stock": 50 },
            { "size": "M", "stock": 100 }
          ],
          "isActive": true
        }
      ]
    }
  }
}
```

#### 2. Listar Kits de um Evento

**GET** `/api/v1/kits/events/:eventId`

Retorna todos os kits ativos de um evento com seus itens.

**Resposta:**
```json
{
  "message": "Kits fetched successfully",
  "data": {
    "kits": [
      {
        "id": "uuid",
        "name": "Kit Básico",
        "description": "Kit com camiseta e número de peito",
        "isActive": true,
        "items": [
          {
            "id": "uuid",
            "name": "Camiseta",
            "description": "Camiseta do evento",
            "sizes": [
              { "size": "P", "stock": 50 },
              { "size": "M", "stock": 100 }
            ],
            "isActive": true
          }
        ]
      }
    ]
  }
}
```

#### 3. Buscar Kit por ID

**GET** `/api/v1/kits/:id`

**Resposta:**
```json
{
  "message": "Kit retrieved successfully",
  "data": {
    "kit": {
      "id": "uuid",
      "name": "Kit Básico",
      "description": "Kit com camiseta e número de peito",
      "isActive": true,
      "items": [...]
    }
  }
}
```

#### 4. Atualizar Kit

**PATCH** `/api/v1/kits/events/:eventId/:kitId`

**Autenticação:** Requerida (Bearer Token)

**Body (todos os campos são opcionais):**
```json
{
  "name": "Kit Básico Atualizado",
  "description": "Nova descrição",
  "isActive": false
}
```

#### 5. Deletar Kit

**DELETE** `/api/v1/kits/events/:eventId/:kitId`

**Autenticação:** Requerida (Bearer Token)

**Nota:** O kit só pode ser deletado se não tiver itens ativos.

**Resposta (200):**
```json
{
  "message": "Kit deleted successfully"
}
```

### Endpoints de Itens do Kit

#### 6. Criar Item do Kit

**POST** `/api/v1/kits/events/:eventId/kits/:kitId/items`

**Autenticação:** Requerida (Bearer Token)

**Body:**
```json
{
  "name": "Boné",
  "description": "Boné do evento",
  "sizes": [
    { "size": "Único", "stock": 200 }
  ],
  "isActive": true              // Opcional (default: true)
}
```

#### 7. Atualizar Item do Kit

**PATCH** `/api/v1/kits/events/:eventId/kits/:kitId/items/:itemId`

**Autenticação:** Requerida (Bearer Token)

**Body (todos os campos são opcionais):**
```json
{
  "name": "Boné Atualizado",
  "description": "Nova descrição",
  "sizes": [
    { "size": "Único", "stock": 150 }
  ],
  "isActive": false
}
```

#### 8. Deletar Item do Kit

**DELETE** `/api/v1/kits/events/:eventId/kits/:kitId/items/:itemId`

**Autenticação:** Requerida (Bearer Token)

**Resposta (200):**
```json
{
  "message": "Kit item deleted successfully"
}
```

---

## Tópicos

Os tópicos são seções de conteúdo informativo sobre o evento (ex: "Descrição", "Kit", "Premiação", "Regulamento").

### Estrutura de Dados

```typescript
interface EventTopic {
  id: string;                    // UUID
  eventId: string;               // UUID do evento
  title: string;                 // Título do tópico
  content: string;               // Conteúdo do tópico (HTML/Markdown)
  isEnabled: boolean;           // Se o tópico está habilitado
  isDefault: boolean;           // Se é um tópico padrão
  order: number;                // Ordem de exibição
  createdAt: string;            // ISO 8601 date string
  updatedAt: string;            // ISO 8601 date string
}
```

### Endpoints

#### 1. Criar Tópico

**POST** `/api/v1/events/:eventId/topics`

**Autenticação:** Requerida (Bearer Token)

**Body:**
```json
{
  "title": "Premiação",
  "content": "<h2>Premiação</h2><p>Os três primeiros colocados de cada categoria receberão medalhas e troféus.</p>",
  "isEnabled": true,            // Opcional (default: true)
  "order": 2                     // Opcional (default: 0)
}
```

**Resposta (201):**
```json
{
  "message": "Topic created successfully",
  "data": {
    "topic": {
      "id": "uuid",
      "eventId": "uuid",
      "title": "Premiação",
      "content": "<h2>Premiação</h2><p>...</p>",
      "isEnabled": true,
      "isDefault": false,
      "order": 2,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

#### 2. Listar Tópicos de um Evento

Os tópicos são retornados automaticamente quando você busca um evento:

**GET** `/api/v1/events/:id`

A resposta inclui os tópicos habilitados, ordenados por `order`:

```json
{
  "message": "Event fetched successfully",
  "data": {
    "event": {
      "id": "uuid",
      "name": "Evento Exemplo",
      "topics": [
        {
          "id": "uuid",
          "title": "Descrição",
          "content": "...",
          "isEnabled": true,
          "isDefault": true,
          "order": 0
        },
        {
          "id": "uuid",
          "title": "Premiação",
          "content": "...",
          "isEnabled": true,
          "isDefault": false,
          "order": 2
        }
      ]
    }
  }
}
```

#### 3. Atualizar Tópico

**PATCH** `/api/v1/events/:eventId/topics/:topicId`

**Autenticação:** Requerida (Bearer Token)

**Body (todos os campos são opcionais):**
```json
{
  "title": "Premiação Atualizada",
  "content": "<h2>Nova Premiação</h2><p>Novo conteúdo...</p>",
  "isEnabled": false,
  "order": 3
}
```

#### 4. Deletar Tópico

**DELETE** `/api/v1/events/:eventId/topics/:topicId`

**Autenticação:** Requerida (Bearer Token)

**Resposta (200):**
```json
{
  "message": "Topic deleted successfully"
}
```

---

## Localizações

As localizações representam diferentes pontos do evento (ex: local de largada, local de chegada, ponto de retirada de kit).

### Estrutura de Dados

```typescript
interface EventLocation {
  id: string;                    // UUID
  eventId: string;               // UUID do evento
  name?: string;                // Nome da localização (opcional)
  address: string;               // Endereço completo
  city: string;                 // Cidade
  state: string;                // Estado
  country: string;              // País
  zipCode?: string;             // CEP (opcional)
  googleMapsLink?: string;      // Link do Google Maps (opcional)
  latitude?: number;            // Latitude (opcional)
  longitude?: number;           // Longitude (opcional)
  createdAt: string;            // ISO 8601 date string
  updatedAt: string;            // ISO 8601 date string
}
```

### Endpoints

#### 1. Criar Localização

**POST** `/api/v1/events/:eventId/locations`

**Autenticação:** Requerida (Bearer Token)

**Body:**
```json
{
  "name": "Local de Largada",
  "address": "Avenida Principal, 123",
  "city": "São Paulo",
  "state": "SP",
  "country": "Brasil",
  "zipCode": "01234-567",       // Opcional
  "googleMapsLink": "https://maps.google.com/...",  // Opcional
  "latitude": -23.5505,          // Opcional
  "longitude": -46.6333          // Opcional
}
```

**Resposta (201):**
```json
{
  "message": "Location created successfully",
  "data": {
    "location": {
      "id": "uuid",
      "eventId": "uuid",
      "name": "Local de Largada",
      "address": "Avenida Principal, 123",
      "city": "São Paulo",
      "state": "SP",
      "country": "Brasil",
      "zipCode": "01234-567",
      "googleMapsLink": "https://maps.google.com/...",
      "latitude": -23.5505,
      "longitude": -46.6333,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  }
}
```

#### 2. Listar Localizações de um Evento

As localizações são retornadas automaticamente quando você busca um evento:

**GET** `/api/v1/events/:id`

A resposta inclui todas as localizações, ordenadas por data de criação:

```json
{
  "message": "Event fetched successfully",
  "data": {
    "event": {
      "id": "uuid",
      "name": "Evento Exemplo",
      "locations": [
        {
          "id": "uuid",
          "name": "Local de Largada",
          "address": "Avenida Principal, 123",
          "city": "São Paulo",
          "state": "SP",
          "country": "Brasil",
          "googleMapsLink": "https://maps.google.com/...",
          "latitude": -23.5505,
          "longitude": -46.6333
        }
      ]
    }
  }
}
```

#### 3. Atualizar Localização

**PATCH** `/api/v1/events/:eventId/locations/:locationId`

**Autenticação:** Requerida (Bearer Token)

**Body (todos os campos são opcionais):**
```json
{
  "name": "Local de Largada Atualizado",
  "address": "Nova Avenida, 456",
  "city": "São Paulo",
  "state": "SP",
  "country": "Brasil",
  "zipCode": "01234-567",
  "googleMapsLink": "https://maps.google.com/...",
  "latitude": -23.5505,
  "longitude": -46.6333
}
```

#### 4. Deletar Localização

**DELETE** `/api/v1/events/:eventId/locations/:locationId`

**Autenticação:** Requerida (Bearer Token)

**Resposta (200):**
```json
{
  "message": "Location deleted successfully"
}
```

---

## Códigos de Status HTTP

- **200 OK**: Operação bem-sucedida
- **201 Created**: Recurso criado com sucesso
- **400 Bad Request**: Requisição inválida (ex: validação falhou)
- **401 Unauthorized**: Token de autenticação ausente ou inválido
- **403 Forbidden**: Usuário não tem permissão (não é organizador do evento)
- **404 Not Found**: Recurso não encontrado
- **500 Internal Server Error**: Erro interno do servidor

## Notas Importantes

1. **Autenticação**: Todas as operações de criação, atualização e exclusão requerem autenticação via Bearer Token (JWT).

2. **Permissões**: Apenas o organizador do evento pode criar, atualizar ou deletar configurações do evento.

3. **Filtros**: Ao buscar um evento (`GET /api/v1/events/:id`), apenas recursos ativos são retornados:
   - Modalidades com `isActive: true`
   - Kits com `isActive: true`
   - Itens de kit com `isActive: true`
   - Tópicos com `isEnabled: true`

4. **Ordenação**:
   - Modalidades: ordenadas por `order` (ascendente)
   - Tópicos: ordenados por `order` (ascendente)
   - Localizações: ordenadas por `createdAt` (ascendente)

5. **Templates de Modalidades**: Os templates são pré-configurados e podem ser usados para facilitar a criação de modalidades comuns.

6. **Estoque de Kits**: O campo `sizes` em `KitItem` contém um array de objetos com `size` e `stock`. O estoque deve ser gerenciado durante as inscrições.

## Exemplo de Uso Completo

```typescript
// 1. Buscar evento com todas as configurações
const eventResponse = await fetch('/api/v1/events/event-uuid');
const { data: { event } } = await eventResponse.json();

// event.modalities - Array de modalidades
// event.kits - Array de kits com itens
// event.topics - Array de tópicos
// event.locations - Array de localizações

// 2. Criar uma nova modalidade
const modalityResponse = await fetch('/api/v1/modalities/events/event-uuid', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Corrida 10km',
    price: 75.00,
    maxParticipants: 200
  })
});

// 3. Criar um kit com itens
const kitResponse = await fetch('/api/v1/kits/events/event-uuid', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Kit Premium',
    description: 'Kit completo com todos os itens',
    items: [
      {
        name: 'Camiseta',
        sizes: [
          { size: 'P', stock: 50 },
          { size: 'M', stock: 100 }
        ]
      }
    ]
  })
});
```

---

## Upload de Imagens

O sistema de upload permite fazer upload de imagens que são automaticamente comprimidas, otimizadas e convertidas para WebP. As imagens são verificadas por malware antes de serem salvas.

### Características

- **Compressão automática**: Imagens são redimensionadas (máx. 500x500px) e comprimidas
- **Conversão para WebP**: Todas as imagens são convertidas para o formato WebP
- **Verificação de malware**: Arquivos são escaneados antes de serem salvos
- **Validação de tipo**: Apenas imagens (JPG, JPEG, PNG, GIF, WebP) são aceitas
- **Limite de tamanho**: Máximo de 10MB por arquivo

### Endpoints

#### 1. Upload de Imagem Única

**POST** `/api/v1/upload/image`

**Autenticação:** Não requerida (público)

**Content-Type:** `multipart/form-data`

**Body:**
```
FormData:
  file: [File] - Arquivo de imagem (JPG, JPEG, PNG, GIF, WebP)
```

**Limites:**
- Tamanho máximo: 10MB
- Formatos aceitos: JPG, JPEG, PNG, GIF, WebP
- A imagem será redimensionada para máximo 500x500px mantendo proporção
- A imagem será convertida para WebP com qualidade 80%

**Resposta (201):**
```json
{
  "message": "Success!",
  "imageUrl": "/uploads/images/1703123456789-123456789.webp",
  "success": true
}
```

**Resposta de Erro:**
```json
{
  "message": "Failed to process image: [mensagem de erro]",
  "success": false
}
```

**Exemplo de uso (JavaScript):**
```typescript
const formData = new FormData();
formData.append('file', fileInput.files[0]);

const response = await fetch('/api/v1/upload/image', {
  method: 'POST',
  body: formData
});

const result = await response.json();
if (result.success) {
  console.log('Imagem enviada:', result.imageUrl);
}
```

**Exemplo de uso (React):**
```typescript
const handleImageUpload = async (file: File) => {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const response = await fetch('/api/v1/upload/image', {
      method: 'POST',
      body: formData,
    });

    const result = await response.json();
    
    if (result.success) {
      // Usar result.imageUrl para exibir ou salvar a URL
      return result.imageUrl;
    } else {
      throw new Error(result.message);
    }
  } catch (error) {
    console.error('Erro no upload:', error);
    throw error;
  }
};
```

#### 2. Upload em Batch (Múltiplas Imagens)

**POST** `/api/v1/upload/batch`

**Autenticação:** Requerida (Bearer Token) + Admin

**Content-Type:** `multipart/form-data`

**Body:**
```
FormData:
  files: [File[]] - Array de arquivos de imagem (máximo 20 arquivos)
```

**Limites:**
- Máximo de 20 arquivos por requisição
- Tamanho máximo por arquivo: 10MB
- Formatos aceitos: JPG, JPEG, PNG, GIF, WebP
- Apenas administradores podem usar este endpoint

**Resposta (201):**
```json
{
  "success": true,
  "message": "Upload em batch concluído: 4 sucesso, 1 falhas",
  "total": 5,
  "success": 4,
  "successCount": 4,
  "failed": 1,
  "urls": [
    "/uploads/images/1703123456789-123456789.webp",
    "/uploads/images/1703123456790-987654321.webp",
    "/uploads/images/1703123456791-456789123.webp",
    "/uploads/images/1703123456792-789123456.webp"
  ],
  "errors": [
    {
      "index": 2,
      "filename": "malware.exe",
      "error": "Arquivo suspeito detectado"
    }
  ]
}
```

**Resposta de Erro (400):**
```json
{
  "success": false,
  "message": "Não é possível fazer upload de mais de 20 arquivos por vez",
  "total": 0,
  "successCount": 0,
  "failed": 0,
  "urls": [],
  "errors": []
}
```

**Exemplo de uso:**
```typescript
const handleBatchUpload = async (files: File[]) => {
  if (files.length > 20) {
    throw new Error('Máximo de 20 arquivos por vez');
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await fetch('/api/v1/upload/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    body: formData
  });

  const result = await response.json();
  return result;
};
```

#### 3. Listar Todos os Uploads

**GET** `/api/v1/upload`

**Autenticação:** Requerida (Bearer Token) + Admin

**Query Parameters:**
- `page` (opcional): Número da página (default: 1)
- `limit` (opcional): Itens por página (default: 50, máx: 100)
- `sortBy` (opcional): Ordenar por `name` ou `date` (default: `date`)
- `sortOrder` (opcional): `asc` ou `desc` (default: `desc`)

**Resposta (200):**
```json
{
  "success": true,
  "message": "Found 18 uploaded files",
  "data": {
    "files": [
      {
        "filename": "1757464893165-228732938.webp",
        "url": "/uploads/images/1757464893165-228732938.webp",
        "size": 45231,
        "sizeFormatted": "44.17 KB",
        "createdAt": "2024-01-15T10:30:00.000Z",
        "modifiedAt": "2024-01-15T10:30:00.000Z",
        "extension": ".webp"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalPages": 5,
      "totalFiles": 18,
      "filesPerPage": 50,
      "hasNextPage": false,
      "hasPreviousPage": false
    }
  }
}
```

**Exemplo de uso:**
```typescript
const getUploads = async (page = 1, limit = 50) => {
  const response = await fetch(
    `/api/v1/upload?page=${page}&limit=${limit}&sortBy=date&sortOrder=desc`,
    {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  const result = await response.json();
  return result.data;
};
```

#### 4. Obter Estatísticas de Uploads

**GET** `/api/v1/upload/stats`

**Autenticação:** Requerida (Bearer Token) + Admin

**Resposta (200):**
```json
{
  "success": true,
  "message": "Statistics calculated for 18 uploaded files",
  "data": {
    "totalFiles": 18,
    "totalSize": 1234567,
    "totalSizeFormatted": "1.18 MB",
    "averageFileSize": 68531.5,
    "averageFileSizeFormatted": "66.92 KB",
    "extensions": {
      ".webp": {
        "count": 15,
        "totalSize": 987654,
        "totalSizeFormatted": "964.51 KB",
        "percentage": "83.3%"
      },
      ".jpg": {
        "count": 3,
        "totalSize": 246913,
        "totalSizeFormatted": "241.12 KB",
        "percentage": "16.7%"
      }
    },
    "dateRange": {
      "earliest": "2024-01-01T00:00:00.000Z",
      "latest": "2024-01-15T10:30:00.000Z"
    }
  }
}
```

#### 5. Deletar Upload (Único)

**DELETE** `/api/v1/upload/:filename`

**Autenticação:** Requerida (Bearer Token) + Admin

**Parâmetros:**
- `filename`: Nome do arquivo a ser deletado (ex: `1757464893165-228732938.webp`)

**Resposta (200):**
```json
{
  "success": true,
  "message": "Arquivo 1757464893165-228732938.webp removido com sucesso",
  "data": {
    "deletedFile": {
      "filename": "1757464893165-228732938.webp",
      "size": 45231,
      "sizeFormatted": "44.17 KB",
      "createdAt": "2024-01-15T10:30:00.000Z",
      "extension": ".webp"
    }
  }
}
```

**Resposta de Erro (400):**
```json
{
  "success": false,
  "message": "Arquivo não encontrado",
  "error": "FILE_NOT_FOUND"
}
```

#### 6. Deletar Múltiplos Uploads

**DELETE** `/api/v1/upload`

**Autenticação:** Requerida (Bearer Token) + Admin

**Body:**
```json
{
  "filenames": [
    "1757464893165-228732938.webp",
    "1757553010899-52223383.webp",
    "1757563193132-521500852.webp"
  ]
}
```

**Limites:**
- Máximo de 50 arquivos por requisição

**Resposta (200):**
```json
{
  "success": true,
  "message": "Processamento concluído: 2 deletados, 1 erros",
  "data": {
    "deletedFiles": [
      {
        "filename": "1757464893165-228732938.webp",
        "size": 45231,
        "sizeFormatted": "44.17 KB",
        "createdAt": "2024-01-15T10:30:00.000Z",
        "extension": ".webp"
      },
      {
        "filename": "1757553010899-52223383.webp",
        "size": 38291,
        "sizeFormatted": "37.37 KB",
        "createdAt": "2024-01-15T11:00:00.000Z",
        "extension": ".webp"
      }
    ],
    "errors": [
      {
        "filename": "arquivo-nao-existe.webp",
        "error": "Arquivo não encontrado"
      }
    ],
    "totalRequested": 3,
    "totalDeleted": 2,
    "totalErrors": 1
  }
}
```

**Exemplo de uso:**
```typescript
const deleteMultipleUploads = async (filenames: string[]) => {
  if (filenames.length > 50) {
    throw new Error('Máximo de 50 arquivos por vez');
  }

  const response = await fetch('/api/v1/upload', {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ filenames })
  });

  const result = await response.json();
  return result;
};
```

### Estrutura de Dados

```typescript
interface UploadFile {
  filename: string;              // Nome do arquivo
  url: string;                   // URL relativa do arquivo
  size: number;                 // Tamanho em bytes
  sizeFormatted: string;         // Tamanho formatado (ex: "44.17 KB")
  createdAt: string;            // ISO 8601 date string
  modifiedAt: string;           // ISO 8601 date string
  extension: string;            // Extensão do arquivo (ex: ".webp")
}

interface BatchUploadResult {
  success: boolean;
  message: string;
  total: number;                // Total de arquivos enviados
  success: number;              // Número de sucessos
  successCount: number;         // Alias para success
  failed: number;               // Número de falhas
  urls: string[];               // URLs dos arquivos enviados com sucesso
  errors: Array<{               // Erros ocorridos
    index: number;
    filename: string;
    error: string;
  }>;
}

interface UploadStats {
  totalFiles: number;
  totalSize: number;
  totalSizeFormatted: string;
  averageFileSize: number;
  averageFileSizeFormatted: string;
  extensions: {
    [extension: string]: {
      count: number;
      totalSize: number;
      totalSizeFormatted: string;
      percentage: string;
    };
  };
  dateRange: {
    earliest: string;
    latest: string;
  };
}
```

### Validações e Limites

#### Upload de Imagem Única
- ✅ **Formatos aceitos**: JPG, JPEG, PNG, GIF, WebP
- ✅ **Tamanho máximo**: 10MB por arquivo
- ✅ **Processamento**: Redimensionamento automático (máx. 500x500px)
- ✅ **Conversão**: Todas as imagens são convertidas para WebP
- ✅ **Segurança**: Verificação de malware antes de salvar

#### Upload em Batch
- ✅ **Máximo de arquivos**: 20 por requisição
- ✅ **Tamanho máximo**: 10MB por arquivo
- ✅ **Autenticação**: Requer token JWT + permissões de admin
- ✅ **Processamento**: Cada arquivo é processado individualmente

#### Deletar Uploads
- ✅ **Máximo de arquivos**: 50 por requisição (apenas para delete múltiplo)
- ✅ **Autenticação**: Requer token JWT + permissões de admin

### Códigos de Status HTTP

- **200 OK**: Operação bem-sucedida
- **201 Created**: Upload realizado com sucesso
- **400 Bad Request**: Requisição inválida (ex: arquivo muito grande, formato inválido)
- **401 Unauthorized**: Token de autenticação ausente ou inválido
- **403 Forbidden**: Usuário não tem permissão (não é admin)
- **404 Not Found**: Arquivo não encontrado (para delete)
- **500 Internal Server Error**: Erro interno do servidor

### Notas Importantes

1. **URLs de Imagens**: As URLs retornadas são relativas (ex: `/uploads/images/filename.webp`). Para usar em tags `<img>`, você pode:
   - Usar a URL relativa diretamente se o frontend estiver no mesmo domínio
   - Concatenar com a URL base da API: `${API_BASE_URL}${imageUrl}`

2. **Compressão Automática**: Todas as imagens são automaticamente:
   - Redimensionadas para máximo 500x500px (mantendo proporção)
   - Comprimidas com qualidade 80%
   - Convertidas para formato WebP

3. **Verificação de Malware**: O sistema tenta verificar arquivos por malware usando ClamAV. Se o ClamAV não estiver disponível, o upload ainda é permitido, mas um aviso é registrado.

4. **Armazenamento**: As imagens são salvas no diretório `uploads/images/` do servidor.

5. **Nomes de Arquivo**: Os arquivos são renomeados automaticamente com o formato: `{timestamp}-{random}.webp` para evitar conflitos.

### Exemplo Completo de Integração

```typescript
// Componente React de Upload
import { useState } from 'react';

const ImageUploader = () => {
  const [uploading, setUploading] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validar tipo de arquivo
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      setError('Formato de arquivo inválido. Use JPG, PNG, GIF ou WebP.');
      return;
    }

    // Validar tamanho (10MB)
    if (file.size > 10 * 1024 * 1024) {
      setError('Arquivo muito grande. Máximo de 10MB.');
      return;
    }

    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/v1/upload/image', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();

      if (result.success) {
        setImageUrl(result.imageUrl);
      } else {
        setError(result.message || 'Erro ao fazer upload');
      }
    } catch (err) {
      setError('Erro ao fazer upload. Tente novamente.');
      console.error(err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <input
        type="file"
        accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
        onChange={handleFileChange}
        disabled={uploading}
      />
      {uploading && <p>Enviando...</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {imageUrl && (
        <div>
          <p>Upload realizado com sucesso!</p>
          <img src={imageUrl} alt="Uploaded" style={{ maxWidth: '300px' }} />
          <p>URL: {imageUrl}</p>
        </div>
      )}
    </div>
  );
};

export default ImageUploader;
```

