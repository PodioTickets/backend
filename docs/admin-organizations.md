# Admin Organizations API — Integration Guide

> **Base URL:** `https://<api-host>/api/v1`
> **Auth:** Bearer token required on all requests (`Authorization: Bearer <access_token>`)
> **Role:** Admin only (`PODIOGO_STAFF` or `ADMIN`)

---

## Endpoints

### 1. List all organizations

```
GET /api/v1/admin/organizations
```

Returns a paginated list of organizations with event count, member count, active status and creation date.

**Query parameters**

| Parameter  | Type      | Default | Description                                              |
|------------|-----------|---------|----------------------------------------------------------|
| `page`     | number    | `1`     | Page number                                              |
| `limit`    | number    | `20`    | Items per page (max 100)                                 |
| `search`   | string    | —       | Filter by name, trade name, email or document (CNPJ/CPF) |
| `isActive` | `true` \| `false` | — | Filter by active status. Omit to return both.    |

**Response `200`**

```json
{
  "message": "Organizations fetched successfully",
  "data": {
    "organizations": [
      {
        "id": "f9e8d7c6-...",
        "name": "Events Co. LTDA",
        "tradeName": "Events Co.",
        "email": "contato@eventsco.com",
        "logoUrl": "https://cdn.example.com/logo.png",
        "document": "12345678000195",
        "phone": "+5511999999999",
        "city": "São Paulo",
        "state": "SP",
        "isActive": true,
        "createdAt": "2026-01-15T10:00:00.000Z",
        "_count": {
          "events": 5,
          "members": 2
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 42,
      "totalPages": 3
    }
  }
}
```

**Field reference**

| Field | Description |
|-------|-------------|
| `_count.events` | Total events created by this organization |
| `_count.members` | Total team members |
| `isActive` | `true` = active, `false` = deactivated by admin |

---

### 2. Get a single organization

```
GET /api/v1/admin/organizations/:id
```

Returns all organization data plus full member list with linked user details.

**Path parameters**

| Parameter | Type          | Description       |
|-----------|---------------|-------------------|
| `id`      | string (UUID) | Organization UUID |

**Response `200`**

```json
{
  "message": "Organization fetched successfully",
  "data": {
    "organization": {
      "id": "f9e8d7c6-...",
      "name": "Events Co. LTDA",
      "tradeName": "Events Co.",
      "document": "12345678000195",
      "logoUrl": null,
      "email": "contato@eventsco.com",
      "phone": "+5511999999999",
      "whatsapp": "+5511999999999",
      "siteUrl": "https://eventsco.com",
      "instagram": "@eventsco",
      "description": "Empresa de eventos corporativos.",
      "zipCode": "01310-100",
      "street": "Av. Paulista",
      "number": "1000",
      "neighborhood": "Bela Vista",
      "city": "São Paulo",
      "state": "SP",
      "ownerName": "João Silva",
      "pix": "contato@eventsco.com",
      "bankName": "Itaú",
      "bankCode": "341",
      "agency": "1234",
      "account": "56789-0",
      "accountType": "CORRENTE",
      "accountHolderName": "Events Co. LTDA",
      "accountHolderDocument": "12345678000195",
      "isActive": true,
      "createdAt": "2026-01-15T10:00:00.000Z",
      "updatedAt": "2026-05-01T08:00:00.000Z",
      "members": [
        {
          "id": "m1m2m3m4-...",
          "role": "OWNER",
          "createdAt": "2026-01-15T10:00:00.000Z",
          "user": {
            "id": "u1u2u3u4-...",
            "firstName": "João",
            "lastName": "Silva",
            "email": "joao@eventsco.com",
            "avatarUrl": null,
            "role": "ORGANIZER",
            "isActive": true
          }
        }
      ],
      "_count": {
        "events": 5,
        "members": 1
      }
    }
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `404`  | Organization not found |

---

### 3. Update an organization

```
PATCH /api/v1/admin/organizations/:id
```

Updates one or more fields of an organization. Send only the fields you want to change.

**Path parameters**

| Parameter | Type          | Description       |
|-----------|---------------|-------------------|
| `id`      | string (UUID) | Organization UUID |

**Request body** *(all fields optional)*

```json
{
  "isActive": false,
  "name": "New Name LTDA",
  "tradeName": "New Name",
  "email": "new@email.com",
  "phone": "+5511999999999",
  "whatsapp": "+5511999999999",
  "siteUrl": "https://newsite.com",
  "instagram": "@newhandle",
  "description": "Updated description.",
  "zipCode": "01310-100",
  "street": "Av. Paulista",
  "number": "2000",
  "neighborhood": "Bela Vista",
  "city": "São Paulo",
  "state": "SP",
  "ownerName": "Maria Souza",
  "pix": "nova@chave.com",
  "bankName": "Bradesco",
  "bankCode": "237",
  "agency": "4321",
  "account": "98765-1",
  "accountType": "CORRENTE",
  "accountHolderName": "Maria Souza",
  "accountHolderDocument": "98765432100"
}
```

**Updatable fields**

| Field | Type | Description |
|-------|------|-------------|
| `isActive` | boolean | `false` deactivates the organization, `true` reactivates |
| `name` | string | Razão social |
| `tradeName` | string | Nome fantasia |
| `email` | string | Contact email |
| `phone` | string | Phone number |
| `whatsapp` | string | WhatsApp number |
| `siteUrl` | string | Website URL |
| `instagram` | string | Instagram handle |
| `description` | string | Description |
| `zipCode` | string | CEP |
| `street` | string | Street address |
| `number` | string | Address number |
| `neighborhood` | string | Bairro |
| `city` | string | City |
| `state` | string | State (UF) |
| `ownerName` | string | Owner/responsible name |
| `pix` | string | PIX key |
| `bankName` | string | Bank name |
| `bankCode` | string | Bank code (e.g. `"341"`) |
| `agency` | string | Bank agency |
| `account` | string | Bank account |
| `accountType` | string | `"CORRENTE"` or `"POUPANCA"` |
| `accountHolderName` | string | Account holder name |
| `accountHolderDocument` | string | CPF/CNPJ of account holder |

**Response `200`**

```json
{
  "message": "Organization updated successfully",
  "data": {
    "organization": {
      "id": "f9e8d7c6-...",
      "name": "New Name LTDA",
      "isActive": false,
      "updatedAt": "2026-05-06T14:00:00.000Z"
    }
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `404`  | Organization not found |

---

## Typical frontend flow

```
1. Load list page
   GET /api/v1/admin/organizations
   → Show table with name, email, events count, isActive badge, createdAt

2. Filter active/inactive
   GET /api/v1/admin/organizations?isActive=true
   GET /api/v1/admin/organizations?isActive=false

3. Search
   GET /api/v1/admin/organizations?search=events+co

4. Click on a row → load detail
   GET /api/v1/admin/organizations/:id
   → Show all organization fields + members table

5. Toggle active/inactive
   PATCH /api/v1/admin/organizations/:id  { "isActive": false }
   → On success: update badge in table row, no page reload needed

6. Edit organization fields
   PATCH /api/v1/admin/organizations/:id  { ...changedFields }
```
