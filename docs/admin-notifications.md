# Admin — Notifications API — Integration Guide

> **Base URL:** `https://<api-host>/api/v1`
> **Auth:** Bearer token required on all requests (`Authorization: Bearer <access_token>`)
> **Role:** Admin only (`PODIOGO_STAFF` or `ADMIN`)

---

## Overview

When an organizer creates a notification for their event, it is saved with status `review` and **no email is sent**. An admin must review and approve or deny it. On approval, all emails are dispatched immediately to confirmed registrants.

**Status lifecycle**

```
review  ──(admin approves)──▶  sent    (emails dispatched)
review  ──(admin denies)───▶   denied  (nothing sent)
```

Once a notification leaves `review` it cannot be reviewed again.

---

## Endpoints

### 1. List notifications

```
GET /api/v1/admin/notifications
```

Returns a paginated list of notifications. When `status` is omitted, all statuses are returned. Filter by `status=review` to see the approval queue.

**Query parameters**

| Parameter  | Type   | Default | Description |
|------------|--------|---------|-------------|
| `page`     | number | `1`     | Page number |
| `limit`    | number | `20`    | Items per page (max 100) |
| `search`   | string | —       | Filter by notification title |
| `eventId`  | string (UUID) | — | Filter by event |
| `status`   | `review` \| `sent` \| `denied` | — | Filter by status. Omit to return all. |

**Response `200`**

```json
{
  "message": "Notifications fetched successfully",
  "data": {
    "items": [
      {
        "id": "notif-uuid",
        "title": "Atualização importante sobre o percurso",
        "channels": ["email"],
        "status": "review",
        "occurredAt": "2026-05-07T10:00:00.000Z",
        "createdAt": "2026-05-07T10:00:00.000Z",
        "event": {
          "id": "evt-uuid",
          "name": "Corrida das Pedras 2026",
          "slug": "corrida-das-pedras-2026",
          "organization": {
            "id": "org-uuid",
            "name": "Events Co. LTDA",
            "tradeName": "Events Co.",
            "logoUrl": "https://cdn.example.com/logo.png"
          }
        },
        "createdBy": {
          "id": "usr-uuid",
          "firstName": "João",
          "lastName": "Silva",
          "email": "joao@eventsco.com"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5,
      "totalPages": 1
    }
  }
}
```

**Field reference**

| Field | Description |
|-------|-------------|
| `status` | `review` = aguardando admin; `sent` = aprovada e enviada; `denied` = recusada |
| `occurredAt` | Timestamp de criação (usado como "data de envio" na listagem do organizador) |
| `event` | Evento e organização relacionados |
| `createdBy` | Usuário organizador que criou a notificação |

> **Note:** `messageHtml` não é retornado na listagem — use o endpoint de detalhe para obtê-lo.

---

### 2. Get notification detail

```
GET /api/v1/admin/notifications/:notificationId
```

Returns the full notification including the HTML content for preview.

**Path parameters**

| Parameter         | Type          | Description         |
|-------------------|---------------|---------------------|
| `notificationId`  | string (UUID) | Notification UUID   |

**Response `200`**

```json
{
  "message": "Notification fetched successfully",
  "data": {
    "id": "notif-uuid",
    "title": "Atualização importante sobre o percurso",
    "channels": ["email"],
    "status": "review",
    "messageHtml": "<p>Olá! Informamos que o percurso da etapa 2 foi alterado...</p>",
    "occurredAt": "2026-05-07T10:00:00.000Z",
    "createdAt": "2026-05-07T10:00:00.000Z",
    "event": {
      "id": "evt-uuid",
      "name": "Corrida das Pedras 2026",
      "slug": "corrida-das-pedras-2026",
      "organization": {
        "id": "org-uuid",
        "name": "Events Co. LTDA",
        "tradeName": "Events Co.",
        "logoUrl": "https://cdn.example.com/logo.png"
      }
    },
    "createdBy": {
      "id": "usr-uuid",
      "firstName": "João",
      "lastName": "Silva",
      "email": "joao@eventsco.com"
    }
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `404`  | Notification not found |

---

### 3. Approve or deny notification

```
POST /api/v1/admin/notifications/:notificationId/review
```

Approves or denies a notification in `review` status. Approval triggers immediate email dispatch to all confirmed registrants of the event.

**Path parameters**

| Parameter         | Type          | Description       |
|-------------------|---------------|-------------------|
| `notificationId`  | string (UUID) | Notification UUID |

**Request body**

```json
{ "action": "approve" }
```

or

```json
{ "action": "deny" }
```

| Field    | Type   | Values                  | Description |
|----------|--------|-------------------------|-------------|
| `action` | string | `"approve"` \| `"deny"` | Required    |

**Response `200` — approved**

```json
{
  "message": "Notification approved and emails dispatched",
  "data": {
    "id": "notif-uuid",
    "status": "sent",
    "title": "Atualização importante sobre o percurso",
    "channels": ["email"],
    "occurredAt": "2026-05-07T10:00:00.000Z"
  }
}
```

**Response `200` — denied**

```json
{
  "message": "Notification denied",
  "data": {
    "id": "notif-uuid",
    "status": "denied",
    "title": "Atualização importante sobre o percurso",
    "channels": ["email"],
    "occurredAt": "2026-05-07T10:00:00.000Z"
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400`  | Notification is not in `review` status (already `sent` or `denied`) |
| `404`  | Notification not found |

> **Note on email dispatch:** The API returns `200` immediately after updating the status. Emails are sent asynchronously in the background — the response does **not** wait for all emails to be delivered.

---

## Typical frontend flow

```
1. Load approval queue
   GET /api/v1/admin/notifications?status=review
   → Show table: event name, org name, title, createdBy, occurredAt, action buttons

2. Filter / search
   GET /api/v1/admin/notifications?status=review&search=percurso
   GET /api/v1/admin/notifications?status=review&eventId=<uuid>

3. Preview content before deciding
   GET /api/v1/admin/notifications/<id>
   → Render messageHtml in a modal/drawer for review

4. Approve
   POST /api/v1/admin/notifications/<id>/review  { "action": "approve" }
   → On 200: update row status to "sent", show success toast
   → Emails are already being dispatched in the background

5. Deny
   POST /api/v1/admin/notifications/<id>/review  { "action": "deny" }
   → On 200: update row status to "denied", show toast

6. View history
   GET /api/v1/admin/notifications?status=sent
   GET /api/v1/admin/notifications?status=denied
```

---

## Status badge reference

| `status`  | Label sugerido | Cor sugerida |
|-----------|----------------|--------------|
| `review`  | Aguardando revisão | Amarelo |
| `sent`    | Enviado | Verde |
| `denied`  | Recusado | Vermelho |
