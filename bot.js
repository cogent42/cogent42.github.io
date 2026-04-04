import "dotenv/config";
import { homedir } from "node:os";
import { Telegraf } from "telegraf";
import { query } from "@anthropic-ai/claude-agent-sdk";

// Ensure common global npm binary paths are in PATH (needed for PM2/systemd)
const extraPaths = [
  `${homedir()}/.npm-global/bin`,
  "/usr/local/bin",
  `${homedir()}/.local/bin`,
  `${homedir()}/.nvm/versions/node/${process.version}/bin`,
];
const currentPath = process.env.PATH || "";
process.env.PATH = [...extraPaths, currentPath].join(":");
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Config ---

const __dirname = dirname(fileURLToPath(import.meta.url));

const REQUIRED_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_USER_ID",
  "ANTHROPIC_API_KEY",
];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`Missing required env var: ${v}`);
    process.exit(1);
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10);
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "25", 10);
const WORKING_DIRECTORY = (process.env.WORKING_DIRECTORY || homedir()).replace(/^~/, homedir());
const MEMORY_DIR = join(__dirname, "memory");
const KNOWLEDGE_DIR = join(__dirname, "knowledge");
const KNOWLEDGE_FILE = join(KNOWLEDGE_DIR, "knowledge.json");
const EXTRACTION_INTERVAL = 10; // extract knowledge every N turns

mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(KNOWLEDGE_DIR, { recursive: true });

// --- State ---

let currentSessionId = null;
let currentModel = "claude-sonnet-4-6";
let processing = false;

// --- Session Memory ---

function getSessionPath(sessionId) {
  return join(MEMORY_DIR, `${sessionId}.json`);
}

function loadSession(sessionId) {
  const path = getSessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  writeFileSync(getSessionPath(session.sessionId), JSON.stringify(session, null, 2));
}

function createSession(sessionId) {
  const session = {
    sessionId,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: currentModel,
    turnCount: 0,
  };
  saveSession(session);
  return session;
}

function addMessage(sessionId, role, content) {
  let session = loadSession(sessionId) || createSession(sessionId);
  session.messages.push({
    role,
    content,
    timestamp: new Date().toISOString(),
  });
  session.turnCount = Math.floor(session.messages.length / 2);
  session.model = currentModel;
  saveSession(session);
  return session;
}

function loadCurrentSessionId() {
  const path = join(MEMORY_DIR, "current.txt");
  if (existsSync(path)) {
    const id = readFileSync(path, "utf-8").trim();
    if (id) currentSessionId = id;
  }
}

function saveCurrentSessionId() {
  writeFileSync(join(MEMORY_DIR, "current.txt"), currentSessionId || "");
}

function archiveCurrentSession() {
  if (!currentSessionId) return;
  const src = getSessionPath(currentSessionId);
  if (existsSync(src)) {
    const dest = join(MEMORY_DIR, `${currentSessionId}-archived.json`);
    renameSync(src, dest);
  }
  currentSessionId = null;
  saveCurrentSessionId();
}

function listSessions() {
  const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".json"));
  return files.map((f) => {
    const stat = statSync(join(MEMORY_DIR, f));
    return { filename: f, size: stat.size, modified: stat.mtime };
  });
}

// --- Knowledge System ---

function loadKnowledge() {
  if (!existsSync(KNOWLEDGE_FILE)) return { entries: [], updatedAt: null };
  try {
    return JSON.parse(readFileSync(KNOWLEDGE_FILE, "utf-8"));
  } catch {
    return { entries: [], updatedAt: null };
  }
}

function saveKnowledge(knowledge) {
  knowledge.updatedAt = new Date().toISOString();
  writeFileSync(KNOWLEDGE_FILE, JSON.stringify(knowledge, null, 2));
}

async function extractKnowledge(sessionId) {
  const session = loadSession(sessionId);
  if (!session || session.messages.length < 4) return;

  const recentMessages = session.messages.slice(-20);
  const existing = loadKnowledge();

  const existingFacts =
    existing.entries.length > 0
      ? existing.entries.map((e) => `- [${e.category}] ${e.fact}`).join("\n")
      : "(none yet)";

  const conversation = recentMessages
    .map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
    .join("\n\n");

  const extractionPrompt = `You are a knowledge extractor. Given this conversation excerpt, extract important facts and decisions worth remembering for future sessions on this server.

Current known facts:
${existingFacts}

Recent conversation:
${conversation}

Extract NEW facts not already known. Categories: server, project, preference, decision, bug, config.
Return ONLY a valid JSON array: [{"fact": "...", "category": "..."}]
Return empty array [] if nothing new worth remembering. No other text.`;

  try {
    let resultText = "";
    for await (const msg of query({
      prompt: extractionPrompt,
      options: {
        maxTurns: 1,
        model: "claude-sonnet-4-6",
        permissionMode: "plan",
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        resultText = msg.result || "";
      }
    }

    // Parse JSON from result
    const jsonMatch = resultText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const newEntries = JSON.parse(jsonMatch[0]);
      if (Array.isArray(newEntries) && newEntries.length > 0) {
        for (const entry of newEntries) {
          existing.entries.push({
            id: randomUUID(),
            fact: entry.fact,
            category: entry.category || "general",
            extractedFrom: sessionId,
            timestamp: new Date().toISOString(),
          });
        }
        saveKnowledge(existing);
        console.log(`Extracted ${newEntries.length} knowledge entries from session ${sessionId}`);
      }
    }
  } catch (err) {
    console.error("Knowledge extraction failed:", err.message);
  }
}

function buildSystemPrompt() {
  const knowledge = loadKnowledge();
  if (knowledge.entries.length === 0) return undefined;

  const facts = knowledge.entries
    .map((e) => `- [${e.category}] ${e.fact}`)
    .join("\n");

  return {
    type: "preset",
    preset: "claude_code",
    append: `\n\nYou have persistent memory from previous sessions on this server:\n\n${facts}\n\nUse this context but verify if unsure — things may have changed.`,
  };
}

// --- Telegram Helpers ---

function startTyping(ctx) {
  const send = () => ctx.sendChatAction("typing").catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

function chunkMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
      // Handle single lines longer than maxLen
      if (line.length > maxLen) {
        for (let i = 0; i < line.length; i += maxLen) {
          chunks.push(line.slice(i, i + maxLen));
        }
        current = "";
      } else {
        current = line;
      }
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendResponse(ctx, text) {
  const chunks = chunkMessage(text || "Done (no output).");
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "MarkdownV2" });
    } catch {
      // MarkdownV2 failed — send as plain text
      try {
        await ctx.reply(chunk);
      } catch (err) {
        console.error("Failed to send message:", err.message);
      }
    }
  }
}

// --- Claude Integration ---

async function runQuery(prompt, model) {
  const options = {
    cwd: WORKING_DIRECTORY,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model,
    maxTurns: MAX_TURNS,
    abortController: new AbortController(),
    stderr: (data) => console.error("[claude stderr]", data),
  };

  // Resume existing session or start new with knowledge
  if (currentSessionId) {
    options.resume = currentSessionId;
  } else {
    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) options.systemPrompt = systemPrompt;
  }

  // 5 minute timeout
  const timeout = setTimeout(() => options.abortController.abort(), 300000);

  let responseText = "";
  let sessionId = currentSessionId;

  try {
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        if (!currentSessionId) {
          currentSessionId = sessionId;
          saveCurrentSessionId();
        }
      }

      if (message.type === "result") {
        if (message.subtype === "success") {
          responseText = message.result || responseText;
        } else {
          // Error result — throw to trigger auto-escalation
          const errorMsg = message.errors?.join(", ") || message.subtype;
          throw new Error(`Claude error: ${errorMsg}`);
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return { responseText, sessionId };
}

async function askClaude(prompt, ctx) {
  const stopTyping = startTyping(ctx);

  try {
    let result;

    try {
      result = await runQuery(prompt, currentModel);
    } catch (err) {
      // Auto-escalate from Sonnet to Opus on failure
      if (currentModel === "claude-sonnet-4-6") {
        await ctx.reply("Escalating to Opus 4.6...");
        currentModel = "claude-opus-4-6";
        result = await runQuery(prompt, currentModel);
      } else {
        throw err;
      }
    }

    const { responseText, sessionId } = result;

    // Log to session memory
    addMessage(sessionId, "user", prompt);
    const session = addMessage(sessionId, "assistant", responseText);

    // Auto-extract knowledge at interval
    if (session.turnCount > 0 && session.turnCount % EXTRACTION_INTERVAL === 0) {
      // Run extraction in background — don't block the response
      extractKnowledge(sessionId).catch((err) =>
        console.error("Background knowledge extraction failed:", err.message)
      );
    }

    return responseText;
  } finally {
    stopTyping();
  }
}

// --- Bot Setup ---

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

// Auth middleware — silent reject for unauthorized users
bot.use((ctx, next) => {
  if (ctx.from?.id !== TELEGRAM_USER_ID) return;
  return next();
});

// --- Commands ---

bot.command("start", (ctx) => {
  ctx.reply(
    `Welcome to Cogent!\n\n` +
      `I give you full Claude Code access to this server.\n` +
      `Send any message and Claude will process it with full system access.\n\n` +
      `Commands:\n` +
      `/reset - Start a fresh conversation\n` +
      `/status - System information\n` +
      `/history - Conversation history stats\n` +
      `/opus - Switch to Opus 4.6\n` +
      `/sonnet - Switch to Sonnet 4.6\n` +
      `/knowledge - View stored knowledge`
  );
});

bot.command("reset", async (ctx) => {
  const stopTyping = startTyping(ctx);
  try {
    if (currentSessionId) {
      await ctx.reply("Extracting knowledge from session...");
      await extractKnowledge(currentSessionId);
    }
    archiveCurrentSession();
    currentModel = "claude-sonnet-4-6";
    await ctx.reply("Session reset. Starting fresh with Sonnet 4.6.");
  } catch (err) {
    await ctx.reply("Reset done (knowledge extraction failed: " + err.message + ")");
    archiveCurrentSession();
  } finally {
    stopTyping();
  }
});

bot.command("status", (ctx) => {
  let sysInfo = "";
  try {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    let diskInfo = "unavailable";
    try {
      diskInfo = execSync("df -h / | tail -1", { encoding: "utf-8" }).trim();
    } catch {}

    let memInfo = "unavailable";
    try {
      memInfo = execSync("free -h 2>/dev/null | head -2 || vm_stat | head -5", {
        encoding: "utf-8",
      }).trim();
    } catch {}

    const knowledge = loadKnowledge();

    sysInfo =
      `Bot uptime: ${hours}h ${mins}m\n` +
      `Model: ${currentModel}\n` +
      `Session: ${currentSessionId || "none"}\n` +
      `Working dir: ${WORKING_DIRECTORY}\n` +
      `Knowledge entries: ${knowledge.entries.length}\n\n` +
      `Disk:\n${diskInfo}\n\n` +
      `Memory:\n${memInfo}`;
  } catch (err) {
    sysInfo = "Error gathering status: " + err.message;
  }
  ctx.reply(sysInfo);
});

bot.command("history", (ctx) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return ctx.reply("No conversation history yet.");
  }

  const totalSize = sessions.reduce((acc, s) => acc + s.size, 0);
  const active = sessions.filter((s) => !s.filename.includes("archived")).length;
  const archived = sessions.filter((s) => s.filename.includes("archived")).length;

  ctx.reply(
    `Sessions: ${sessions.length} total (${active} active, ${archived} archived)\n` +
      `Total size: ${(totalSize / 1024).toFixed(1)} KB\n` +
      `Current session: ${currentSessionId || "none"}`
  );
});

bot.command("opus", (ctx) => {
  currentModel = "claude-opus-4-6";
  ctx.reply("Switched to Opus 4.6");
});

bot.command("sonnet", (ctx) => {
  currentModel = "claude-sonnet-4-6";
  ctx.reply("Switched to Sonnet 4.6");
});

bot.command("knowledge", (ctx) => {
  const knowledge = loadKnowledge();
  if (knowledge.entries.length === 0) {
    return ctx.reply("No knowledge stored yet. It builds up as you use the bot.");
  }

  const text = knowledge.entries
    .map((e) => `[${e.category}] ${e.fact}`)
    .join("\n");

  ctx.reply(`Stored knowledge (${knowledge.entries.length} entries):\n\n${text}`);
});

// --- Text Handler ---

bot.on("text", async (ctx) => {
  if (processing) {
    return ctx.reply("Still working on your previous message...");
  }

  processing = true;
  try {
    const response = await askClaude(ctx.message.text, ctx);
    await sendResponse(ctx, response);
  } catch (err) {
    console.error("Error handling message:", err);
    await ctx.reply("Error: " + (err.message || "Unknown error"));
  } finally {
    processing = false;
  }
});

// --- Launch ---

loadCurrentSessionId();
bot.launch();
console.log(`Cogent started | Model: ${currentModel} | CWD: ${WORKING_DIRECTORY}`);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
