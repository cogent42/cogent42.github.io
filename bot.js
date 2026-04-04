import "dotenv/config";
import { homedir } from "node:os";
import { Telegraf } from "telegraf";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync as readPkgFile } from "node:fs";
import { join as joinPkg, dirname as dirnamePkg } from "node:path";
import { fileURLToPath as fileURLToPathPkg } from "node:url";

// Version from package.json
const __dirnamePkg = dirnamePkg(fileURLToPathPkg(import.meta.url));
const VERSION = JSON.parse(readPkgFile(joinPkg(__dirnamePkg, "package.json"), "utf-8")).version;

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

const REQUIRED_VARS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    console.error(`Missing required env var: ${v}`);
    process.exit(1);
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_USER_ID = parseInt(process.env.TELEGRAM_USER_ID, 10);
const MAX_TURNS = parseInt(process.env.MAX_TURNS || "25", 10);
const WORKING_DIRECTORY = (process.env.WORKING_DIRECTORY || homedir()).replace(
  /^~/,
  homedir()
);
const BOT_NAME = process.env.BOT_NAME || "cogent42";
const BOT_PERSONALITY = process.env.BOT_PERSONALITY || "";
const MEMORY_DIR = join(__dirname, "memory");
const KNOWLEDGE_DIR = join(__dirname, "knowledge");
const KNOWLEDGE_FILE = join(KNOWLEDGE_DIR, "knowledge.json");
const EXTRACTION_INTERVAL = 10;
const MAX_KNOWLEDGE_ENTRIES = 100;

mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(KNOWLEDGE_DIR, { recursive: true });

// --- State ---

let currentSessionId = null;
let currentModel = "claude-sonnet-4-6";
let processing = false;
let currentAbortController = null;
let autoEscalated = false;

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
  writeFileSync(
    getSessionPath(session.sessionId),
    JSON.stringify(session, null, 2)
  );
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
        // Prune oldest entries if over limit
        if (existing.entries.length > MAX_KNOWLEDGE_ENTRIES) {
          existing.entries = existing.entries.slice(-MAX_KNOWLEDGE_ENTRIES);
        }
        saveKnowledge(existing);
        console.log(
          `Extracted ${newEntries.length} knowledge entries from session ${sessionId}`
        );
      }
    }
  } catch (err) {
    console.error("Knowledge extraction failed:", err.message);
  }
}

function buildSystemPrompt() {
  const parts = [];

  if (BOT_PERSONALITY) {
    parts.push(`Your personality: ${BOT_PERSONALITY}`);
  }

  const knowledge = loadKnowledge();
  if (knowledge.entries.length > 0) {
    const facts = knowledge.entries
      .map((e) => `- [${e.category}] ${e.fact}`)
      .join("\n");
    parts.push(
      `You have persistent memory from previous sessions on this server:\n\n${facts}\n\nUse this context but verify if unsure — things may have changed.`
    );
  }

  if (parts.length === 0) return undefined;

  return {
    type: "preset",
    preset: "claude_code",
    append: "\n\n" + parts.join("\n\n"),
  };
}

// --- Telegram Helpers ---

function startTyping(ctx) {
  const send = () => ctx.sendChatAction("typing").catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function markdownToHtml(text) {
  const blocks = [];

  // Extract fenced code blocks
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(
      `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code)}</code></pre>`
    );
    return `\x00B${idx}\x00`;
  });

  // Extract inline code
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = blocks.length;
    blocks.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00B${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Convert markdown formatting
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // Re-insert code blocks
  result = result.replace(
    /\x00B(\d+)\x00/g,
    (_, idx) => blocks[parseInt(idx)]
  );

  return result;
}

function chunkMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let current = "";

  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      if (current) chunks.push(current);
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
      await ctx.reply(markdownToHtml(chunk), { parse_mode: "HTML" });
    } catch {
      // HTML parse failed — send as plain text
      try {
        await ctx.reply(chunk);
      } catch (err) {
        console.error("Failed to send message:", err.message);
      }
    }
  }
}

async function downloadTelegramFile(ctx, fileId, filename) {
  const fileLink = await ctx.telegram.getFileLink(fileId);
  const response = await fetch(fileLink.href);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const destPath = join(WORKING_DIRECTORY, filename);
  writeFileSync(destPath, buffer);
  return destPath;
}

// --- Processing Lock ---

async function withProcessingLock(ctx, fn) {
  if (processing) {
    return ctx.reply("Still working on your previous message...");
  }
  processing = true;
  try {
    await fn();
  } catch (err) {
    if (err.name === "AbortError" || err.message?.includes("aborted")) {
      await ctx.reply("Query cancelled.");
    } else {
      console.error("Error:", err);
      await ctx.reply("Error: " + (err.message || "Unknown error"));
    }
  } finally {
    processing = false;
    currentAbortController = null;
  }
}

// --- Claude Integration ---

async function runQuery(prompt, model, isRetry = false) {
  const abortController = new AbortController();
  currentAbortController = abortController;

  const options = {
    cwd: WORKING_DIRECTORY,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    model,
    maxTurns: MAX_TURNS,
    abortController,
    stderr: (data) => console.error("[claude stderr]", data),
  };

  // Resume existing session or start new with knowledge + personality
  if (currentSessionId && !isRetry) {
    options.resume = currentSessionId;
  } else {
    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) options.systemPrompt = systemPrompt;
  }

  // 5 minute timeout
  const timeout = setTimeout(() => abortController.abort(), 300000);

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
          const errorMsg = message.errors?.join(", ") || message.subtype;
          throw new Error(`Claude error: ${errorMsg}`);
        }
      }
    }
  } catch (err) {
    // If session resume failed, retry with a fresh session (once)
    if (currentSessionId && !isRetry && !abortController.signal.aborted) {
      console.error(
        "Session resume may have failed, retrying fresh:",
        err.message
      );
      currentSessionId = null;
      saveCurrentSessionId();
      clearTimeout(timeout);
      currentAbortController = null;
      return runQuery(prompt, model, true);
    }
    throw err;
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
      // Auto-escalate from Sonnet to Opus on failure (not on cancel)
      if (currentModel === "claude-sonnet-4-6" && err.name !== "AbortError") {
        await ctx.reply("Escalating to Opus 4.6 for this query...");
        autoEscalated = true;
        result = await runQuery(prompt, "claude-opus-4-6");
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
      extractKnowledge(sessionId).catch((err) =>
        console.error("Background knowledge extraction failed:", err.message)
      );
    }

    // Auto-revert to Sonnet after a successful auto-escalation
    if (autoEscalated) {
      currentModel = "claude-sonnet-4-6";
      autoEscalated = false;
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
    `Welcome to ${BOT_NAME}! (v${VERSION})\n\n` +
      `I give you full Claude Code access to this server.\n` +
      `Send any message and Claude will process it with full system access.\n` +
      `You can also send photos and documents.\n\n` +
      `Commands:\n` +
      `/reset - Start a fresh conversation\n` +
      `/cancel - Cancel the current query\n` +
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
    autoEscalated = false;
    await ctx.reply("Session reset. Starting fresh with Sonnet 4.6.");
  } catch (err) {
    await ctx.reply(
      "Reset done (knowledge extraction failed: " + err.message + ")"
    );
    archiveCurrentSession();
  } finally {
    stopTyping();
  }
});

bot.command("cancel", async (ctx) => {
  if (!processing || !currentAbortController) {
    return ctx.reply("Nothing to cancel.");
  }
  currentAbortController.abort();
  await ctx.reply("Cancelling...");
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
      `${BOT_NAME} v${VERSION}\n` +
      `Uptime: ${hours}h ${mins}m\n` +
      `Model: ${currentModel}\n` +
      `Session: ${currentSessionId || "none"}\n` +
      `Working dir: ${WORKING_DIRECTORY}\n` +
      `Knowledge: ${knowledge.entries.length}/${MAX_KNOWLEDGE_ENTRIES} entries\n\n` +
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
  const active = sessions.filter(
    (s) => !s.filename.includes("archived")
  ).length;
  const archived = sessions.filter((s) =>
    s.filename.includes("archived")
  ).length;

  ctx.reply(
    `Sessions: ${sessions.length} total (${active} active, ${archived} archived)\n` +
      `Total size: ${(totalSize / 1024).toFixed(1)} KB\n` +
      `Current session: ${currentSessionId || "none"}`
  );
});

bot.command("opus", (ctx) => {
  currentModel = "claude-opus-4-6";
  autoEscalated = false;
  ctx.reply("Switched to Opus 4.6");
});

bot.command("sonnet", (ctx) => {
  currentModel = "claude-sonnet-4-6";
  autoEscalated = false;
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

// --- Message Handlers ---

bot.on("text", (ctx) =>
  withProcessingLock(ctx, async () => {
    const response = await askClaude(ctx.message.text, ctx);
    await sendResponse(ctx, response);
  })
);

bot.on("photo", (ctx) =>
  withProcessingLock(ctx, async () => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const filename = `photo_${Date.now()}.jpg`;
    const filePath = await downloadTelegramFile(ctx, photo.file_id, filename);
    const caption = ctx.message.caption || "";
    const prompt = `User sent a photo (saved at ${filePath}).${caption ? ` Caption: ${caption}` : ""} Describe or process the image as needed.`;
    const response = await askClaude(prompt, ctx);
    await sendResponse(ctx, response);
  })
);

bot.on("document", (ctx) =>
  withProcessingLock(ctx, async () => {
    const doc = ctx.message.document;
    const filename = doc.file_name || `file_${Date.now()}`;
    const filePath = await downloadTelegramFile(ctx, doc.file_id, filename);
    const caption = ctx.message.caption || "";
    const prompt = `User sent a file: ${filename} (saved at ${filePath}, ${(doc.file_size / 1024).toFixed(1)} KB).${caption ? ` Caption: ${caption}` : ""} Process the file as needed.`;
    const response = await askClaude(prompt, ctx);
    await sendResponse(ctx, response);
  })
);

bot.on(["voice", "video", "video_note", "sticker", "animation"], (ctx) => {
  ctx.reply(
    "I can handle text messages, photos, and documents. Voice, video, and stickers aren't supported yet."
  );
});

// --- Launch ---

loadCurrentSessionId();

// Register slash commands in Telegram's menu
bot.telegram
  .setMyCommands([
    { command: "start", description: "Welcome message" },
    { command: "reset", description: "Start a fresh conversation" },
    { command: "cancel", description: "Cancel the current query" },
    { command: "status", description: "System information" },
    { command: "history", description: "Conversation history stats" },
    { command: "opus", description: "Switch to Opus 4.6" },
    { command: "sonnet", description: "Switch to Sonnet 4.6" },
    { command: "knowledge", description: "View stored knowledge" },
  ])
  .catch((err) => console.error("Failed to set bot commands:", err.message));

bot.launch();
console.log(
  `${BOT_NAME} v${VERSION} started | Model: ${currentModel} | CWD: ${WORKING_DIRECTORY}`
);

function gracefulShutdown(signal) {
  if (currentAbortController) currentAbortController.abort();
  bot.stop(signal);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});
