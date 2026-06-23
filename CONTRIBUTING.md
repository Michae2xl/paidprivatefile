# Contributing

Thanks for your interest in Paid Private File. This is the Next.js app; the Rust
payment scanner (`ppf-scanner`) lives in its own service.

## Prerequisites

- **Node.js 20** (the project pins `node >= 20.9.0`).

## Setup

```bash
npm install
npm run dev          # http://localhost:3000
```

The app runs with safe defaults; secrets/flags are documented in
[`.env.example`](.env.example). Real on-chain payments and browser-to-browser Nym
delivery are gated behind environment flags — see `.env.example` and
[ARCHITECTURE.md](ARCHITECTURE.md).

## Before opening a PR

Run the full gate locally — CI runs the same three steps on every push/PR:

```bash
npm run check   # next typegen + tsc --noEmit (typecheck)
npm test        # vitest (unit/integration)
npm run build   # next build
```

Please add or update tests for any logic change; the pure helpers
(`lib/*.ts`) are unit-tested and new logic should be too.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`.

## Security

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md) — do not open a
public issue for security problems.
