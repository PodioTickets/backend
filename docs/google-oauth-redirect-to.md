# Google OAuth — propagação de `redirect_to` (callback no backend)

Permite que o login com Google volte para o destino que o usuário tentava acessar
(ex.: `/checkout/ingressos?eventId=XYZ`), preservando o caminho através do round-trip do
Google. O canal é o parâmetro **`state`** do OAuth (o Google só devolve o `state`).

## Fluxo

```
1. Front:    GET {API}/api/v1/auth/google?redirect_to=%2Fcheckout%2Fingressos%3FeventId%3DXYZ
                └─ GoogleAuthGuard saneia o redirect_to, assina em `state` (JWT, 10min, nonce)
                   e redireciona pro consent do Google (redirect_uri = callback do BACKEND).

2. Google →  GET {API}/api/v1/auth/google/callback?code=...&state=...
                └─ backend valida o `state`, extrai o redirect_to saneado e faz 302 para:
                   {FRONTEND}/auth/callback?code=...&redirect_to=/checkout/ingressos?eventId=XYZ

3. Front:    lê `code` + `redirect_to` da URL e troca o code por tokens:
             POST {API}/api/v1/auth/google/validate { code, redirectUri }
             → 200 { tokens, user }. Depois navega para `redirect_to`.
```

Em caso de cancelamento/erro no Google, o callback redireciona com
`{FRONTEND}/auth/callback?error=<motivo>` (+ `redirect_to` quando disponível).

## Segurança

- **Open-redirect:** `redirect_to` é saneado por `sanitizeRelativePath` (só `/caminho`
  relativo; rejeita `http(s)://`, `//host`, `/\host`, `javascript:`, `data:`, CR/LF e
  caracteres de controle). Saneado na **assinatura** e de novo na **verificação** + ao montar
  a URL final via `URL`/`searchParams` (re-encoda). Defesa em profundidade — o front sanear não basta.
- **Tampering/CSRF:** `state` é um JWT assinado (HS256, `JWT_SECRET`) com `expiresIn=10m` e nonce
  aleatório. State adulterado/expirado/forjado → `redirect_to` vira `null` (cai no login default,
  nunca quebra o fluxo). *Melhoria futura possível:* vincular o state a um cookie de sessão pré-login
  para CSRF estrito.

## ⚠️ Passos de integração (fora do código deste repo)

1. **Env (`GOOGLE_CALLBACK_URL`)** — deve apontar para o **backend** agora:
   - Local: `http://localhost:3333/api/v1/auth/google/callback`
   - Homolog/Prod: `https://<API_HOST>/api/v1/auth/google/callback`
2. **Google Cloud Console** — adicionar esse mesmo URL em *Authorized redirect URIs* do OAuth Client.
3. **Frontend** — no `POST /api/v1/auth/google/validate`, enviar
   `redirectUri = {API}/api/v1/auth/google/callback` (o `redirect_uri` da troca do code precisa
   bater exatamente com o usado no consent). Antes era `{FRONTEND}/auth/callback`.

## Arquivos

- `src/common/utils/safe-redirect.util.ts` — `sanitizeRelativePath`.
- `src/app/auth/oauth-state.service.ts` — `sign`/`verify` do state.
- `src/app/auth/guards/google-auth.guard.ts` — injeta o `state` no consent.
- `src/app/auth/auth.controller.ts` — `GET /auth/google` (doc do `redirect_to`) + `GET /auth/google/callback`.
- `src/app/auth/strategies/google.strategy.ts` — `callbackURL` aponta pro backend.

Testes: `safe-redirect.util.spec.ts` (17) + `oauth-state.service.spec.ts` (8).
