<p align="center">
  <img src="logo.png" alt="cogent42" width="120">
</p>

<h1 align="center">cogent42</h1>

<p align="center"><strong>Full Claude Code access on your server, controlled from Telegram.</strong></p>

cogent42 is a single-user Telegram bot that gives you complete Claude Code capabilities -- bash execution, file operations, search, and more -- on any server you run it on. Set it up on your VPS, message it from Telegram, and operate your server through Claude.

## Features

- **Full Claude Code access** -- bash, file read/write/edit, and search via Telegram
- **Photo & document support** -- send images and files, Claude processes them on your server
- **Live progress updates** -- see what Claude is doing in real-time (tool use, file reads) via editable messages
- **Acknowledgment reactions** -- instant visual feedback (eyes on receive, checkmark on success, X on error)
- **Scheduled tasks** -- schedule recurring tasks in plain English (e.g. "check disk space every morning at 9am")
- **Interactive confirmations** -- inline keyboard buttons for destructive actions like /reset and /opus
- **Persistent memory** -- conversations survive restarts through session resume
- **Automatic knowledge extraction** -- facts, decisions, and server config are pulled from conversations into a knowledge base (capped at 100 entries, auto-pruned)
- **Cross-session context** -- knowledge is injected into new sessions so Claude remembers what matters
- **Smart model routing** -- defaults to Claude Sonnet 4.6, auto-escalates to Opus 4.6 on failure, auto-reverts after success
- **Manual model switching** -- `/opus` and `/sonnet` commands
- **Cancel in-flight queries** -- `/cancel` aborts the current query
- **Bot personality** -- optional personality config that also evolves through knowledge extraction
- **Graceful shutdown** -- in-flight queries and scheduled jobs are cleanly aborted on SIGINT/SIGTERM
- **Session resume fallback** -- automatically starts a fresh session if resume fails

## Prerequisites

- Node.js 18+
- A [Claude Code](https://claude.ai/claude-code) subscription (the setup script installs the CLI if needed)
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))

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
| `MAX_TURNS` | No | `25` | Max agentic turns per query |
| `WORKING_DIRECTORY` | No | `~` | Directory where Claude operates |
| `BOT_NAME` | No | `cogent42` | Display name for your bot |
| `BOT_PERSONALITY` | No | -- | Optional personality (e.g. "concise and direct") |

## Commands

| Command | Description |
|---|---|
| `/start` | Welcome message |
| `/reset` | Clear conversation, extract knowledge, start fresh |
| `/cancel` | Cancel the current in-flight query |
| `/schedule` | Schedule a recurring task in plain English |
| `/schedules` | View and manage scheduled tasks |
| `/unschedule` | Remove a scheduled task by ID |
| `/status` | System info (version, uptime, disk, memory, model, session, schedules) |
| `/history` | Session stats |
| `/opus` | Switch to Opus 4.6 |
| `/sonnet` | Switch to Sonnet 4.6 |
| `/knowledge` | View stored knowledge entries |

## Scheduling

Schedule recurring tasks in plain English -- no cron syntax needed:

```
/schedule check disk space every morning at 9am
/schedule remind me about deploy every friday at 5pm
/schedule run backup every sunday at 2am
/schedule check server health every 30 minutes
```

Claude parses your intent into a schedule. Tasks persist across restarts. Manage them with `/schedules` (interactive buttons) or `/unschedule <id>`.

## How Knowledge Works

cogent42 maintains a persistent knowledge base across conversations:

1. After every **10 conversation turns**, cogent42 extracts facts and decisions from the conversation.
2. On `/reset`, knowledge is **always extracted** before the session is archived.
3. Extracted knowledge is **injected into the system prompt** of new sessions.
4. Knowledge is capped at **100 entries** -- oldest entries are pruned when the limit is reached.
5. This keeps the context window small while maintaining persistent memory across conversations.

## Architecture

```
cogent42/
  bot.js                  # Single-file entry point (ESM)
  ecosystem.config.cjs    # PM2 config (.cjs because project is ESM)
  setup.js                # Interactive setup script
  memory/                 # Session files + current.txt for persistence
  knowledge/              # knowledge.json, schedules.json
```

## Running with PM2

For production use, run cogent42 with PM2 for process management and automatic restarts.

```bash
# Start
pm2 start ecosystem.config.cjs

# View logs
pm2 logs cogent42

# Check status
pm2 status

# Restart / Stop
pm2 restart cogent42
pm2 stop cogent42

# Survive reboots
pm2 save && pm2 startup
```

## Security

- **Single user** -- the bot is locked to one Telegram user ID. Unauthorized users are silently rejected.
- **Never commit secrets** -- `.env`, `memory/`, and `knowledge/` are in `.gitignore`.
- **File downloads** -- photos and documents sent via Telegram are saved to the working directory for Claude to process.

> **Warning:** cogent42 uses `bypassPermissions` mode, which gives Claude **unrestricted access** to your server -- bash, file system, everything. Only run this on machines you are comfortable giving full access to.

## License

MIT
