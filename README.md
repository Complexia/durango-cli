# durango-cli

Command-line client for the Durango API.

## Install

```bash
bun install
bun link
```

## Configure

```bash
export DURANGO_API_KEY="dgo_..."
export DURANGO_BASE_URL="https://heydurango.com"
```

Or persist local config:

```bash
durango config set --api-key dgo_... --base-url https://heydurango.com
```

Environment variables override saved config.

## Usage

```bash
durango credits
durango models list --type video

durango image generate \
  --model google/gemini-3-pro-image-preview \
  --prompt "A watercolor lighthouse at dawn" \
  --aspect-ratio 16:9 \
  --out lighthouse.png

durango video generate \
  --model google/veo-3.1-fast \
  --prompt "A slow dolly shot through a rainy neon market" \
  --duration 5 \
  --resolution 720p \
  --out market.mp4
```

Video generation starts an async Durango run, polls until completion by default, then downloads the first completed video when `--out` is provided. Use `--no-wait` to print the run JSON immediately.
