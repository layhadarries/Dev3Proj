# Installation

## Verified prerequisites

The repository currently verifies:

- Node.js 24 in GitHub Actions
- pnpm 12.23.0 in GitHub Actions
- Linux CI and a local TypeScript/Node environment
- Next.js 15.5.29
- Vitest 4.1.12

The package declares Node.js >=20, but the CI and documented build baseline use
Node.js 24 and pnpm 12.23.0.

## Clone and install

```bash
git clone https://github.com/layhadarries/Dev3Proj.git
cd Dev3Proj
git switch main
pnpm install --frozen-lockfile
```

## Build

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

## Start the web app

```bash
cd apps/web
pnpm dev
```

The app normally expects a same-origin browser at `http://localhost:3000`.
Set `APP_ORIGIN` if the development hostname differs.

## Firewall-only demo

```bash
node packages/security/scripts/demo.mjs match
node packages/security/scripts/demo.mjs warn
node packages/security/scripts/demo.mjs extra
node packages/security/scripts/demo.mjs recipient
node packages/security/scripts/demo.mjs amount
node packages/security/scripts/demo.mjs fee
node packages/security/scripts/demo.mjs tamper
```

Only the security demo scenarios use public Devnet RPC reads and fixture/public
addresses; they do not load private keys, sign or submit. The integrated web
app has a separate explicit wallet signing and Devnet submission flow.
