---
paths:
  - "src/db/**"
  - "supabase/**"
---

# Database Rules

## Queries
- Always use parameterised queries — no string interpolation
- Never SELECT * — specify columns explicitly
- Add appropriate indexes for filtered/sorted columns
- Keep transactions short — release locks fast

## Migrations
- All schema changes via migration files
- Migrations must be reversible (include down migration)
- Test migrations on a copy of production data before applying

## Data safety
- Soft-delete records (deleted_at) rather than hard DELETE
- Archive old data before bulk deletes
- Never truncate tables in production scripts
