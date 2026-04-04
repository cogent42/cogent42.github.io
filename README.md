# Cogent

**Full Claude Code access on your server, controlled from Telegram.**

Cogent is a single-user Telegram bot that gives you complete Claude Code capabilities -- bash execution, file operations, search, and more -- on any server you run it on. Set it up on your VPS, message it from Telegram, and operate your server through Claude.

## Features

- **Full Claude Code access** -- bash, file read/write/edit, and search via Telegram
- **Persistent memory** -- conversations survive restarts through session resume
- **Automatic knowledge extraction** -- facts, decisions, and server config are pulled from conversations into a knowledge base
- **Cross-session context** -- knowledge is injected into new sessions so Claude remembers what matters
- **Smart model routing** -- defaults to Claude Sonnet 4.6, auto-escalates to Opus 4.6 on failure
- **Manual model switching** -- `/opus` and `/sonnet` commands

## Prerequisites

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- An Anthropic API key (from [console.anthropic.com](https://console.anthropic.com))

## Quick Start

**Automated setup (recommended):**

```bash
git clone https://github.com/cogent42/cogent42.git
cd cogent42
node setup.js
```

The interactive setup walks you through everything.

**Manual setup:**

```bash
git clone https://github.com/cogent42/cogent42.git
cd cogent42
cp .env.example .env
# Edit .env with your tokens
npm install
node bot.js
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | -- | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_USER_ID` | Yes | -- | Your user ID from [@userinfobot](https://t.me/userinfobot) |
| `ANTHROPIC_API_KEY` | Yes | -- | API key from [console.anthropic.com](https://console.anthropic.com) |
| `MAX_TURNS` | No | `25` | Max agentic turns per query |
| `WORKING_DIRECTORY` | No | `/root` | Directory where Claude operates |

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/reset` | Clear conversation, extract knowledge, start fresh |
| `/status` | System info (uptime, disk, memory, model, session) |
| `/history` | Session stats |
| `/opus` | Switch to Opus 4.6 |
| `/sonnet` | Switch to Sonnet 4.6 |
| `/knowledge` | View stored knowledge entries |

## How Knowledge Works

Cogent maintains a persistent knowledge base across conversations:

1. After every **10 conversation turns**, Cogent extracts facts and decisions from the conversation.
2. On `/reset`, knowledge is **always extracted** before the session is archived.
3. Extracted knowledge is **injected into the system prompt** of new sessions.
4. This keeps the context window small while maintaining persistent memory across conversations.

## Architecture

```
cogent/
  bot.js                  # Single-file entry point (~350 lines, ESM)
  ecosystem.config.cjs    # PM2 config (.cjs because project is ESM)
  setup.js                # Interactive setup script
  memory/                 # Session files + current.txt for persistence
  knowledge/              # knowledge.json with extracted facts
```

## Running with PM2

For production use, run Cogent with PM2 for process management and automatic restarts.

```bash
# Start
pm2 start ecosystem.config.cjs

# View logs
pm2 logs cogent

# Check status
pm2 status

# Restart / Stop
pm2 restart cogent
pm2 stop cogent

# Survive reboots
pm2 save && pm2 startup
```

## Security

- **Single user** -- the bot is locked to one Telegram user ID. Unauthorized users are silently rejected.
- **Never commit secrets** -- `.env`, `memory/`, and `knowledge/` are in `.gitignore`.

> **Warning:** Cogent uses `bypassPermissions` mode, which gives Claude **unrestricted access** to your server -- bash, file system, everything. Only run this on machines you are comfortable giving full access to.

## License

MIT
