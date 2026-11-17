---
name: security-audit
description: Run a security audit of specified files or the whole codebase. Use for security reviews, vulnerability checks.
user-invocable: true
---

Perform a systematic security audit.

## Audit scope
- Authentication & authorisation
- Input validation & sanitisation
- Secret & credential handling
- Dependency vulnerabilities (`pip-audit -r requirements.txt`)
- Error handling (no info leakage)
- Injection vulnerabilities (command injection, XSS, path traversal)

## Findings format
```
[SEVERITY] Title
File: path/to/file.py:line
Issue: What the vulnerability is
Impact: What an attacker could do
Fix: Specific remediation steps
```
Severity levels: CRITICAL / HIGH / MEDIUM / LOW / INFO
