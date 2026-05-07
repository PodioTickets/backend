# Admin Retention API — Integration Guide

> **Base URL:** `https://<api-host>/api/v1`
> **Auth:** Bearer token required on all requests (`Authorization: Bearer <access_token>`)
> **Role:** Admin only (`PODIOGO_STAFF` or `ADMIN`)

All monetary values are in **centavos (BRL)**. Divide by 100 to display as R$.

---

## Overview

Every paid order has 10% of its net value held in retention until an admin explicitly releases it for that event. Once released:
- The held amount is moved to the organizer's available balance.
- All future orders from that same event are **no longer subject to retention** — 100% goes straight to available balance.

---

## Endpoints

### 1. List events with pending retention

```
GET /api/v1/admin/retention
```

Returns all events that still have retention to be released, plus summary stats for the current month.

**Query parameters**

| Parameter | Type                        | Default | Description                                        |
|-----------|-----------------------------|---------|----------------------------------------------------|
| `page`    | number                      | `1`     | Page number                                        |
| `limit`   | number                      | `20`    | Items per page (max 100)                           |
| `search`  | string                      | —       | Filter by event name or organization name/email    |
| `status`  | `"pending"` \| `"released"` | —       | Filter by retention status. Omit to return both.   |

**Response `200`**

```json
{
  "message": "Events with retention fetched successfully",
  "data": {
    "stats": {
      "pendingCount": 2,
      "totalPendingVolume": 10000,
      "totalProcessedThisMonth": 42000
    },
    "events": [
      {
        "id": "e1b2c3d4-...",
        "name": "Rock in Rio 2026",
        "slug": "rock-in-rio-2026",
        "logoUrl": "https://cdn.example.com/logo.png",
        "eventDate": "2026-09-20T00:00:00.000Z",
        "retentionRate": 0.1,
        "organization": {
          "id": "f9e8d7c6-...",
          "name": "Events Co.",
          "email": "contato@eventsco.com",
          "logoUrl": null
        },
        "status": "pending",
        "retainedAmount": 5000,
        "grossRevenue": 100000,
        "releasedAt": null,
        "releasedBy": null,
        "auditNotes": null
      },
      {
        "id": "a9b8c7d6-...",
        "name": "Festival de Inverno",
        "slug": "festival-inverno",
        "logoUrl": null,
        "eventDate": "2026-01-10T00:00:00.000Z",
        "retentionRate": 0.1,
        "organization": {
          "id": "f9e8d7c6-...",
          "name": "Events Co.",
          "email": "contato@eventsco.com",
          "logoUrl": null
        },
        "status": "released",
        "retainedAmount": 8000,
        "grossRevenue": null,
        "releasedAt": "2026-05-01T10:00:00.000Z",
        "releasedBy": {
          "id": "u1u2u3u4-...",
          "firstName": "Admin",
          "lastName": "User",
          "email": "admin@podio.com"
        },
        "auditNotes": "Reviewed and approved."
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 3,
      "totalPages": 1
    }
  }
}
```

**Stats fields**

> Stats always reflect the **global** state, regardless of the `status` filter applied to the list.

| Field | Description |
|-------|-------------|
| `pendingCount` | Number of events currently waiting for retention release |
| `totalPendingVolume` | Sum of all `retainedAmount` across all pending events (centavos) |
| `totalProcessedThisMonth` | Total retention released in the current calendar month (centavos) |

**Event fields**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Event UUID — use this in the release endpoint |
| `status` | `"pending"` \| `"released"` | Current retention status |
| `retainedAmount` | number | Centavos held (pending) or released (released) |
| `grossRevenue` | number \| null | Total gross revenue — only available for `pending` events |
| `retentionRate` | number | Always `0.1` (10%) |
| `releasedAt` | ISO string \| null | Timestamp of release — only set when `status = "released"` |
| `releasedBy` | object \| null | Admin who released — only set when `status = "released"` |
| `auditNotes` | string \| null | Notes added at release time |

---

### 2. Release retention for an event

```
POST /api/v1/admin/retention/:eventId/release
```

Releases the 10% retention for the given event. After this, no future orders from this event will be held in retention.

**Path parameters**

| Parameter | Type   | Description      |
|-----------|--------|------------------|
| `eventId` | string (UUID) | ID of the event |

**Request body** *(optional)*

```json
{
  "notes": "Audit completed after event review on 2026-05-06."
}
```

| Field   | Type   | Required | Description                       |
|---------|--------|----------|-----------------------------------|
| `notes` | string | No       | Internal audit notes for the record |

**Response `201`**

```json
{
  "message": "Retention released successfully",
  "data": {
    "audit": {
      "id": "a1b2c3d4-...",
      "eventId": "e1b2c3d4-...",
      "auditedById": "u9f8e7d6-...",
      "retentionReleased": 5000,
      "notes": "Audit completed after event review on 2026-05-06.",
      "createdAt": "2026-05-06T14:30:00.000Z"
    },
    "retentionReleased": 5000
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400`  | Retention for this event was already released |
| `404`  | Event not found |

---

## Typical frontend flow

```
1. Load page (show all)
   GET /api/v1/admin/retention
   → Display stats cards (pendingCount, totalPendingVolume, totalProcessedThisMonth)
   → Render table with status badge per row ("Pending" / "Released")

2. Filter by status
   GET /api/v1/admin/retention?status=pending
   GET /api/v1/admin/retention?status=released
   → Stats remain global regardless of filter

3. Admin clicks "Release" on a pending row
   POST /api/v1/admin/retention/:eventId/release
   → On success: row status changes from "pending" to "released"
               row now shows releasedAt, releasedBy, auditNotes
               stats update (pendingCount -1, totalPendingVolume - retainedAmount)

4. Search / pagination
   GET /api/v1/admin/retention?search=rock&page=2&limit=20&status=pending
```

---

## Display formatting

```ts
// centavos → BRL
const formatBRL = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);

// retentionRate → percentage string
const formatRate = (rate: number) => `${(rate * 100).toFixed(0)}%`;

// Examples
formatBRL(5000)   // "R$ 50,00"
formatBRL(100000) // "R$ 1.000,00"
formatRate(0.1)   // "10%"
```
