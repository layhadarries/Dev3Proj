# Repository structure

| Path | Responsibility |
|---|---|
| `apps/web` | Next.js UI, API routes, session and rate-limit server code |
| `apps/web/lib/client` | Browser API, wallet and transfer flow |
| `apps/web/lib/server` | Authentication, gateway composition, HTTP validation, transport |
| `packages/agent` | Intent parsing, transaction building, explanations |
| `packages/security` | Decoder, RPC, simulation, verification and confirmation gateway |
| `packages/shared` | Zod contracts and wire serialization |
| `docs` | Canonical team documentation and this Wiki export |
| `docs/wiki` | GitHub Wiki-ready Markdown pages |
| `.github/workflows` | Build, test, audit and secret-scanning CI |

Package boundaries are enforced by ESLint. The agent package must not import
from security, and the security package must not import from agent or web.
