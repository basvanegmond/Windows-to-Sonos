---
paths:
  - "src/api/**"
  - "app/api/**"
---

# API Route Rules

## Input validation
- Validate ALL inputs with Zod schemas
- Parse request body: `schema.parse(await req.json())`
- Return 400 with `{ error: "..." }` on validation failure

## Authentication
- All protected routes: `const user = await requireAuth()`
- Never trust client-sent user IDs — use `auth.uid()`

## Error handling
- Consistent format: `{ error: string, code?: string }`
- Never expose stack traces or internal errors
- Log errors with context (route, user_id)
- HTTP codes: 400 bad input, 401 no auth, 403 forbidden, 404 not found, 429 rate limited, 500 server error

## Rate limiting
- Apply rate limiting to all public endpoints
- Use environment-configured thresholds

## Response
- Always return typed JSON responses
- Set Cache-Control headers where appropriate
