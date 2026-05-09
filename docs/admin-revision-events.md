# Admin — Revision Events API — Integration Guide

> **Base URL:** `https://<api-host>/api/v1`
> **Auth:** Bearer token required on all requests (`Authorization: Bearer <access_token>`)
> **Role:** Admin only (`PODIOGO_STAFF` or `ADMIN`)

---

## Overview

When an organizer finishes setting up an event and clicks "Submit for review", the event status changes from `DRAFT` to `REVISION`. From that point:

- The organizer **cannot** publish the event themselves.
- An admin must review and approve it via the endpoints below.
- On approval the event is set to `PUBLISHED` and its financial settings are locked.

---

## Endpoints

### 1. List events pending review

```
GET /api/v1/admin/events/revision
```

Returns a paginated list of events currently in `REVISION` status, ordered by most recently submitted.

**Query parameters**

| Parameter        | Type   | Default | Description                                         |
|------------------|--------|---------|-----------------------------------------------------|
| `page`           | number | `1`     | Page number                                         |
| `limit`          | number | `20`    | Items per page (max 100)                            |
| `search`         | string | —       | Filter by event name, slug, city or organization name |
| `organizationId` | string (UUID) | — | Filter by a specific organization               |

**Response `200`**

```json
{
  "message": "Revision events fetched successfully",
  "data": {
    "events": [
      {
        "id": "evt-uuid",
        "name": "Corrida das Pedras 2026",
        "slug": "corrida-das-pedras-2026",
        "logoUrl": "https://cdn.example.com/logo.png",
        "bannerUrl": "https://cdn.example.com/banner.png",
        "status": "REVISION",
        "city": "São Paulo",
        "state": "SP",
        "country": "BR",
        "location": "Parque Ibirapuera",
        "eventDate": "2026-08-10T07:00:00.000Z",
        "registrationStartDate": "2026-05-01T00:00:00.000Z",
        "registrationEndDate": "2026-08-01T23:59:59.000Z",
        "organizerFeePercent": 5.0,
        "retentionRate": 0.10,
        "createdAt": "2026-04-20T10:00:00.000Z",
        "updatedAt": "2026-05-06T12:00:00.000Z",
        "organization": {
          "id": "org-uuid",
          "name": "Events Co. LTDA",
          "tradeName": "Events Co.",
          "email": "contato@eventsco.com",
          "logoUrl": "https://cdn.example.com/org-logo.png",
          "document": "12345678000195",
          "phone": "+5511999999999"
        },
        "_count": {
          "registrations": 0,
          "tickets": 3
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 4,
      "totalPages": 1
    }
  }
}
```

**Field reference**

| Field | Description |
|-------|-------------|
| `updatedAt` | **Data de submissão** — timestamp when the organizer submitted the event for review (status changed to `REVISION`). Use this as the "Submitted at" label in the UI. |
| `organization` | Full organization object — name, email, document (CNPJ/CPF), logo, phone |
| `_count.registrations` | Total registrations (will be 0 for new events) |
| `_count.tickets` | Number of ticket types configured |
| `organizerFeePercent` | Organizer fee percentage (e.g. `5.0` = 5%) |
| `retentionRate` | Retention percentage (e.g. `0.10` = 10%) |

---

### 2. Approve and publish an event

```
POST /api/v1/admin/events/:eventId/publish
```

Approves a `REVISION` event. Sets the status to `PUBLISHED` and locks the financial settings so they can no longer be changed by the organizer.

**Path parameters**

| Parameter  | Type          | Description    |
|------------|---------------|----------------|
| `eventId`  | string (UUID) | Event UUID     |

**Request body**

None — no body required.

**Response `200`**

```json
{
  "message": "Event approved and published successfully",
  "data": {
    "event": {
      "id": "evt-uuid",
      "name": "Corrida das Pedras 2026",
      "status": "PUBLISHED",
      "financialSettingsLockedAt": "2026-05-06T14:30:00.000Z",
      "updatedAt": "2026-05-06T14:30:00.000Z"
    }
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| `400`  | Event is not in `REVISION` status |
| `404`  | Event not found |

---

## Typical frontend flow

```
1. Load review queue
   GET /api/v1/admin/events/revision
   → Show table with: event name, organization name, city/state, eventDate,
     _count.tickets, updatedAt ("Submitted at"), action button

2. Search / filter
   GET /api/v1/admin/events/revision?search=corrida
   GET /api/v1/admin/events/revision?organizationId=<uuid>

3. Admin reviews event details
   (Navigate to event detail page or open drawer — use existing
    GET /api/v1/admin/events/:id or GET /api/v1/events/:slug endpoints)

4. Admin approves
   POST /api/v1/admin/events/<eventId>/publish
   → On 200: remove the event row from the queue table (or show "Published" badge)
   → On 400: show error "Event is no longer in REVISION status"
   → On 404: show error "Event not found"
```

---

## Status lifecycle

```
DRAFT  ──(organizer submits)──▶  REVISION  ──(admin approves)──▶  PUBLISHED
```

- Only the organizer can move `DRAFT → REVISION` (via their "submit for review" action).
- Only an admin can move `REVISION → PUBLISHED` (via `POST /admin/events/:id/publish`).
- Financial settings (`organizerFeePercent`, `retentionRate`, payment config) are locked at the moment of admin approval (`financialSettingsLockedAt`).
