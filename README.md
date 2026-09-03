```
 _  _____ _____   __  __ _____ ____ ___    _     ____ _     ___
| |/ /_ _| ____| |  \/  | ____|  _ \_ _|  / \   / ___| |   |_ _|
| ' / | ||  _|   | |\/| |  _| | | | | |  / _ \ | |   | |    | |
| . \ | || |___  | |  | | |___| |_| | | / ___ \| |___| |___ | |
|_|\_\___|_____| |_|  |_|_____|____/___/_/   \_\____|_____|___|
```

# KIE Media CLI (`kie`)

[![npm](https://img.shields.io/npm/v/kie-media-cli.svg)](https://www.npmjs.com/package/kie-media-cli)
[![node](https://img.shields.io/node/v/kie-media-cli.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/kie-media-cli.svg)](LICENSE)

A Node.js CLI tool for generating **photos, videos, and audio** via [KIE API](https://kie.ai) ([docs.kie.ai](https://docs.kie.ai)).

A single unified interface over all KIE platform APIs: universal Market API (jobs), Seedance, GPT Image, Wan, Suno, ElevenLabs, and dozens of other models.

**Zero runtime dependencies** — requires only Node.js >= 18.

---

## 🚀 Quick Start & Setup

The executable command is **`kie`**:

```bash
npx -y kie-media-cli setup
```

The interactive setup wizard guides you through two steps:

1. **KIE API Key** — detects `KIE_API_KEY` from environment or prompts for it, verifies account credit balance via API, and saves to `~/.kie-media/config.json` (chmod 600).
2. **AI Agent Skill** — installs the `kie-generate` skill via `npx -y skills add MIt9/kie-skills/kie-generate`.

---

## 🔑 Setting the API Key

Get your API key at [https://kie.ai/api-key](https://kie.ai/api-key).

You can configure the key using any of the following 3 options:

1. **Interactive Setup Wizard** (prompts for key, verifies balance, installs agent skill):
   ```bash
   kie setup
   ```
2. **Direct CLI Configuration** (saves to `~/.kie-media/config.json`):
   ```bash
   kie config --set-key YOUR_API_KEY
   ```
3. **Environment Variable** (ideal for CI/CD or `.env`):
   ```bash
   export KIE_API_KEY=YOUR_API_KEY
   ```

Verify your key and credit balance at any time:
```bash
kie credits
```

---

## 📦 Installation Options

- **Global via npm**: `npm i -g kie-media-cli`
- **From local source**: `npm install -g .` in the root repository folder

Non-interactive setup for CI/CD: `kie setup --yes` (reads key from `KIE_API_KEY`).

---

## 💻 Usage Examples

```bash
# 1. Text-to-Image — create task, wait for completion, download to ./out
kie run google/nano-banana --prompt "red cat in a spacesuit, cinematic" \
  --wait --download ./out

# 2. Image-to-Video — local image is automatically uploaded first
kie run veo3_fast --prompt "cat waving hand" --image ./cat.png \
  --set aspect_ratio=16:9 --wait --timeout 10m --download ./out

# 3. Music (Suno, custom mode)
kie run suno --prompt "song about autumn city" \
  --set customMode=true --set style="indie rock, female vocal" --set title="Autumn" \
  --wait --download ./out

# 4. Text-to-Speech (ElevenLabs TTS)
kie run elevenlabs/text-to-speech-turbo-2-5 \
  --prompt "Hello! This is a test voiceover." --wait --download ./out

# 5. Image Upscale
kie run topaz/image-upscale --image ./photo.png --wait --download ./out

# 6. Cost Estimation — check price without spending credits
kie cost google/nano-banana --prompt "red cat"
```

### Asynchronous Pattern (without `--wait`)

If you call `run` without the `--wait` flag, the command immediately returns a `taskId`:

```bash
kie run google/nano-banana --prompt "cat"          # Returns taskId
kie status <taskId>                                # Check task status
kie wait <taskId> --timeout 10m                    # Blocking wait until completed
kie download <URL> -o result.png                    # Download result file
```

*Note: Result URLs expire after ~24 hours, so downloading immediately is recommended.*

---

## 🔄 Live Model Registry & Dynamic Schemas

New models are released frequently on KIE API. The CLI fetches the catalog dynamically:

- **Live Model Registry**: `kie models` fetches the live catalog from `docs.kie.ai` and caches it for 24 hours (`~/.kie-media/models-cache.json`). Force refresh: `kie models --refresh`.
- **Offline Fallback**: Fresh cache → Stale cache → Built-in seed registry.
- **Dynamic Input Schemas**: Before launching, `kie run` pulls the input schema from documentation to validate required parameters pre-flight.
- **Inspect Model Schema**:
  ```bash
  kie schema bytedance/seedance-2-mini          # Parameter table, types, enums, defaults
  kie schema bytedance/seedance-2-mini --raw    # Raw OpenAPI YAML
  ```
- **Recommend Best Models**:
  ```bash
  kie recommend image                           # Popular image models with pricing
  kie recommend video                           # Popular video models
  ```

---

## 📊 Pricing & Credit Tracking

```bash
kie credits                                     # Account credit balance
kie pricing --category video                    # Live model pricing in credits and USD
kie pricing --search "edit"                     # Search pricing by task or synonyms
```

---

## 🛠 Complete Command Reference

| Command | Description |
| :--- | :--- |
| `kie setup [--yes] [--local] [--repo REPO]` | Interactive setup wizard (API key + agent skill) |
| `kie credits` | Display account credit balance |
| `kie models [--refresh] [--category image\|video\|audio] [--search TEXT]` | Live model registry from docs.kie.ai |
| `kie recommend image\|video\|audio [--refresh]` | Recommended models by category & quality/price tier |
| `kie pricing [--refresh] [--category image\|video\|audio] [--search TEXT]` | Live model pricing in credits and USD |
| `kie schema MODEL [--raw]` | Inspect model input schema from documentation |
| `kie upload FILE` | Upload local file to KIE storage → returns `fileUrl` |
| `kie run MODEL [--prompt ...] [--image ...] [--set k=v ...] [--wait] [--download DIR]` | Create generation task |
| `kie cost MODEL [--prompt ...] [--image ...] [--set k=v ...]` | Estimate cost without creating task |
| `kie status TASK_ID [--api ...]` | Check task status |
| `kie wait TASK_ID [--timeout 10m] [--interval 5s]` | Wait for task completion (polling) |
| `kie download URL [-o PATH]` | Download generated asset |
| `kie config --set-key KEY` | Save API key to configuration file |

### Hierarchical Command Syntax
The CLI also supports subcommand aliases:
- `kie generate create ...` ↔ `kie run ...`
- `kie generate cost ...` ↔ `kie cost ...`
- `kie generate list` ↔ View local task history
- `kie generate get <id>` ↔ `kie status <id>`
- `kie generate wait <id>` ↔ `kie wait <id>`
- `kie model list` ↔ `kie models`
- `kie model get <model>` ↔ `kie schema <model>`

### Helpful Flags
- `--json` — Machine-readable JSON output for all commands.
- `--dry-run` — For `run`/`cost`: inspect payload without making network requests or spending credits.
- `--timeout 10m` / `--interval 3s` — Duration parsing support (`m` for minutes, `s` for seconds).

---

## 🤖 Skills for AI Agents (`MIt9/kie-skills`)

A suite of skills for autonomous AI agents (Claude Code, Cursor, Codex, Antigravity) is available in [MIt9/kie-skills](https://github.com/MIt9/kie-skills):

- **`kie-generate`** — Image, video, and audio generation via KIE API (`kie run`, `kie models`, `kie cost`).
- **`kie-brandkit`** — Brand identity, palette, logo, mockup, and brandbook generation.
- **`kie-product-photoshoot`** — Studio and lifestyle product visuals.

### Installing Skills

```bash
# Core generation skill:
npx -y skills add MIt9/kie-skills/kie-generate

# Design & product skills:
npx -y skills add MIt9/kie-skills/kie-brandkit
npx -y skills add MIt9/kie-skills/kie-product-photoshoot
```

---

## 🧪 Testing

Run built-in test runner (offline, zero network calls):

```bash
npm test              # node:test
npm run audit:registry # Audit seed registry against live docs.kie.ai schemas
```

---

## 📄 License

MIT © kie-media-cli
