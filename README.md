# durango-cli

Durango command line interface for linking your local Codex runtime to Durango Code.

## Install

```bash
npm install -g durango-cli
```

## Usage

```bash
durango login
durango init
durango start
```

- `durango login` now links the machine and immediately starts the local bridge session.
- Run `durango init` inside any project you want linked.
- Keep `durango` or `durango start` running anywhere on the machine; it will pick up newly initialized projects automatically without a restart.

## Local development

```bash
bun install
bun run build
bun run test
```

When you run the CLI from this source checkout, it now defaults to the local Durango stack:

- relay: `http://localhost:8788`
- web: `http://localhost:3000`

If the stored CLI session was linked against a different relay, the CLI will ask you to log in again for the current target instead of silently connecting to the wrong environment.
