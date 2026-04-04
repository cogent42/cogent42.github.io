import "dotenv/config";
import { homedir } from "node:os";
import { Telegraf, Markup } from "telegraf";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync as readPkgFile } from "node:fs";
import { join as joinPkg, dirname as dirnamePkg } from "node:path";
import { fileURLToPath as fileURLToPathPkg } from "node:url";

// Version from package.json
const __dirnamePkg = dirnamePkg(fileURLToPathPkg(import.meta.url));
const VERSION = JSON.parse(
  readPkgFile(joinPkg(__dirnamePkg, "package.json"), "utf-8")
).version;

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
const SCHEDULES_FILE = join(KNOWLEDGE_DIR, "schedules.json");
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
For each fact, assign importance:
- "permanent" — names, identities, key people, core infrastructure, long-term preferences, important decisions that should never be forgotten
- "normal" — temporary bugs, one-off tasks, short-term context that may become stale

Return ONLY a valid JSON array: [{"fact": "...", "category": "...", "importance": "permanent"|"normal"}]
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
            importance: entry.importance || "normal",
            extractedFrom: sessionId,
            timestamp: new Date().toISOString(),
          });
        }
        // Smart pruning: drop normal entries first, never touch permanent ones
        if (existing.entries.length > MAX_KNOWLEDGE_ENTRIES) {
          const permanent = existing.entries.filter((e) => e.importance === "permanent");
          const normal = existing.entries.filter((e) => e.importance !== "permanent");
          const keepNormal = MAX_KNOWLEDGE_ENTRIES - permanent.length;
          if (keepNormal > 0) {
            existing.entries = [...permanent, ...normal.slice(-keepNormal)];
          } else {
            // More permanent than cap — keep newest permanent entries
            existing.entries = permanent.slice(-MAX_KNOWLEDGE_ENTRIES);
          }
        }
        // Trigger consolidation when approaching capacity (80%)
        if (existing.entries.length > MAX_KNOWLEDGE_ENTRIES * 0.8) {
          consolidateKnowledge(existing).catch((err) =>
            console.error("Knowledge consolidation failed:", err.message)
          );
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

async function consolidateKnowledge(knowledge) {
  const entries = knowledge.entries;
  if (entries.length < 20) return; // not enough to consolidate

  const factsText = entries
    .map((e, i) => `${i}. [${e.importance}][${e.category}] ${e.fact}`)
    .join("\n");

  const consolidationPrompt = `You are a knowledge base manager. This knowledge base has ${entries.length} entries and is approaching capacity (${MAX_KNOWLEDGE_ENTRIES} max).

Current entries:
${factsText}

Your job:
1. Merge duplicate or highly related facts into single entries
2. Drop facts that are clearly outdated or no longer relevant
3. Keep ALL permanent entries unless they're exact duplicates (merge those)
4. Normal entries about resolved bugs or completed one-off tasks can be dropped

Return ONLY a valid JSON array of the consolidated entries: [{"fact": "...", "category": "...", "importance": "permanent"|"normal"}]
Keep as many entries as needed — just remove genuine redundancy and staleness. Do not drop things that are still useful.`;

  try {
    let resultText = "";
    for await (const msg of query({
      prompt: consolidationPrompt,
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
      const consolidated = JSON.parse(jsonMatch[0]);
      if (Array.isArray(consolidated) && consolidated.length > 0) {
        const before = knowledge.entries.length;
        knowledge.entries = consolidated.map((e) => ({
          id: randomUUID(),
          fact: e.fact,
          category: e.category || "general",
          importance: e.importance || "normal",
          extractedFrom: "consolidation",
          timestamp: new Date().toISOString(),
        }));
        saveKnowledge(knowledge);
        console.log(
          `Consolidated knowledge: ${before} → ${knowledge.entries.length} entries`
        );
      }
    }
  } catch (err) {
    console.error("Knowledge consolidation failed:", err.message);
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

// --- Schedules System ---

function loadSchedules() {
  if (!existsSync(SCHEDULES_FILE)) return [];
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveSchedules(schedules) {
  writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

function matchesCron(cronExpr, date) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    const value = fields[i];

    if (part === "*") continue;

    // Step syntax: */N
    if (part.startsWith("*/")) {
      const step = parseInt(part.slice(2), 10);
      if (isNaN(step) || step <= 0) return false;
      if (value % step !== 0) return false;
      continue;
    }

    // Comma-separated values: 1,3,5
    const values = part.split(",").map((v) => parseInt(v, 10));
    if (!values.includes(value)) return false;
  }

  return true;
}

async function parseScheduleWithClaude(text) {
  let resultText = "";
  for await (const msg of query({
    prompt: `Parse this scheduling request into a cron expression and task description.

User said: "${text}"

Return ONLY valid JSON (no other text): {"cron": "<5-field cron expression>", "task": "<what to do>", "description": "<human-readable schedule>"}

Examples:
- "check disk space every morning at 9am" → {"cron": "0 9 * * *", "task": "Check disk space and report usage", "description": "Every day at 9:00 AM"}
- "remind me about deploy every friday at 5pm" → {"cron": "0 17 * * 5", "task": "Remind about the deploy", "description": "Every Friday at 5:00 PM"}
- "run backup every sunday at 2am" → {"cron": "0 2 * * 0", "task": "Run the backup", "description": "Every Sunday at 2:00 AM"}
- "check server health every 30 minutes" → {"cron": "*/30 * * * *", "task": "Check server health and report status", "description": "Every 30 minutes"}
- "every 6 hours check if nginx is running" → {"cron": "0 */6 * * *", "task": "Check if nginx is running and report", "description": "Every 6 hours"}`,
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

  const jsonMatch = resultText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse schedule");
  return JSON.parse(jsonMatch[0]);
}

async function runScheduledJob(job) {
  console.log(`Running scheduled job: ${job.id} — ${job.task}`);
  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === job.id);

  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 300000);

    const options = {
      cwd: WORKING_DIRECTORY,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: currentModel,
      maxTurns: MAX_TURNS,
      abortController,
      stderr: (data) => console.error("[schedule stderr]", data),
    };

    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) options.systemPrompt = systemPrompt;

    let responseText = "";
    for await (const message of query({
      prompt: `[Scheduled task] ${job.task}`,
      options,
    })) {
      if (message.type === "result" && message.subtype === "success") {
        responseText = message.result || "";
      }
    }
    clearTimeout(timeout);

    // Send result to user
    const header = `📋 Scheduled: ${job.description}\n\n`;
    const chunks = chunkMessage(header + (responseText || "Done (no output)."));
    for (const chunk of chunks) {
      try {
        await bot.telegram.sendMessage(TELEGRAM_USER_ID, markdownToHtml(chunk), {
          parse_mode: "HTML",
        });
      } catch {
        try {
          await bot.telegram.sendMessage(TELEGRAM_USER_ID, chunk);
        } catch (err) {
          console.error("Failed to send scheduled result:", err.message);
        }
      }
    }

    if (idx !== -1) {
      schedules[idx].lastRun = new Date().toISOString();
      schedules[idx].lastResult = "success";
      saveSchedules(schedules);
    }
  } catch (err) {
    console.error(`Scheduled job ${job.id} failed:`, err.message);
    try {
      await bot.telegram.sendMessage(
        TELEGRAM_USER_ID,
        `❌ Scheduled task failed: ${job.description}\nError: ${err.message}`
      );
    } catch {}

    if (idx !== -1) {
      schedules[idx].lastRun = new Date().toISOString();
      schedules[idx].lastResult = "error: " + err.message;
      saveSchedules(schedules);
    }
  }
}

let scheduleTickInterval = null;

function startScheduler() {
  scheduleTickInterval = setInterval(() => {
    const now = new Date();
    const schedules = loadSchedules();
    for (const job of schedules) {
      if (!job.enabled) continue;
      if (matchesCron(job.cron, now)) {
        runScheduledJob(job).catch((err) =>
          console.error("Schedule tick error:", err.message)
        );
      }
    }
  }, 60000);
}

// --- Telegram Helpers ---

function startTyping(ctx) {
  const send = () => ctx.sendChatAction("typing").catch(() => {});
  send();
  const interval = setInterval(send, 4000);
  return () => clearInterval(interval);
}

async function reactToMessage(ctx, emoji) {
  try {
    await ctx.telegram.setMessageReaction(
      ctx.chat.id,
      ctx.message.message_id,
      [{ type: "emoji", emoji }]
    );
  } catch {}
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

// --- Progress Message ---

function createProgressMessage(ctx) {
  let msgId = null;
  let chatId = ctx.chat.id;
  let lastUpdate = 0;
  let lastText = "";

  return {
    async init() {
      try {
        const sent = await ctx.reply("⏳ Working...");
        msgId = sent.message_id;
      } catch {}
    },

    update(text) {
      if (!msgId) return;
      const now = Date.now();
      if (now - lastUpdate < 3000) return; // rate limit: max 1 edit per 3s
      if (text === lastText) return;
      lastUpdate = now;
      lastText = text;
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      ctx.telegram
        .editMessageText(chatId, msgId, null, `⏳ ${truncated}`)
        .catch(() => {});
    },

    async finish(finalText) {
      if (!msgId) return null;
      const chunks = chunkMessage(finalText || "Done (no output).");
      if (chunks.length === 1) {
        // Single chunk — edit the progress message in place
        try {
          await ctx.telegram.editMessageText(
            chatId,
            msgId,
            null,
            markdownToHtml(chunks[0]),
            { parse_mode: "HTML" }
          );
        } catch {
          try {
            await ctx.telegram.editMessageText(chatId, msgId, null, chunks[0]);
          } catch {
            // Edit failed entirely — fall back to new messages
            return null;
          }
        }
        return msgId;
      }
      // Multiple chunks — delete progress and send all chunks
      try {
        await ctx.telegram.deleteMessage(chatId, msgId);
      } catch {}
      return null; // caller should use sendResponse
    },
  };
}

// --- Processing Lock ---

async function withProcessingLock(ctx, fn) {
  if (processing) {
    return ctx.reply("Still working on your previous message...");
  }
  processing = true;
  await reactToMessage(ctx, "👀");
  try {
    await fn();
    await reactToMessage(ctx, "✅");
  } catch (err) {
    await reactToMessage(ctx, "❌");
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

async function runQuery(prompt, model, onProgress, isRetry = false) {
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

  if (currentSessionId && !isRetry) {
    options.resume = currentSessionId;
  } else {
    const systemPrompt = buildSystemPrompt();
    if (systemPrompt) options.systemPrompt = systemPrompt;
  }

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

      // Surface progress from intermediate messages
      if (onProgress) {
        if (message.type === "assistant" && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === "tool_use") {
              onProgress(`Using tool: ${block.name}`);
            } else if (block.type === "text" && block.text) {
              onProgress(block.text.slice(0, 200));
            }
          }
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
    if (currentSessionId && !isRetry && !abortController.signal.aborted) {
      console.error(
        "Session resume may have failed, retrying fresh:",
        err.message
      );
      currentSessionId = null;
      saveCurrentSessionId();
      clearTimeout(timeout);
      currentAbortController = null;
      return runQuery(prompt, model, onProgress, true);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  return { responseText, sessionId };
}

async function askClaude(prompt, ctx) {
  const stopTyping = startTyping(ctx);
  const progress = createProgressMessage(ctx);
  await progress.init();

  try {
    let result;

    try {
      result = await runQuery(prompt, currentModel, (text) =>
        progress.update(text)
      );
    } catch (err) {
      if (currentModel === "claude-sonnet-4-6" && err.name !== "AbortError") {
        progress.update("Escalating to Opus 4.6...");
        autoEscalated = true;
        result = await runQuery(prompt, "claude-opus-4-6", (text) =>
          progress.update(text)
        );
      } else {
        throw err;
      }
    }

    const { responseText, sessionId } = result;

    addMessage(sessionId, "user", prompt);
    const session = addMessage(sessionId, "assistant", responseText);

    if (session.turnCount > 0 && session.turnCount % EXTRACTION_INTERVAL === 0) {
      extractKnowledge(sessionId).catch((err) =>
        console.error("Background knowledge extraction failed:", err.message)
      );
    }

    if (autoEscalated) {
      currentModel = "claude-sonnet-4-6";
      autoEscalated = false;
    }

    // Try to edit progress message with final response
    const edited = await progress.finish(responseText);
    if (!edited) {
      await sendResponse(ctx, responseText);
    }

    return responseText;
  } finally {
    stopTyping();
  }
}

// --- Bot Setup ---

const bot = new Telegraf(TELEGRAM_BOT_TOKEN, {
  handlerTimeout: 1_800_000, // 30 minutes — Claude queries can run long
});

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
      `/schedule - Schedule a recurring task\n` +
      `/schedules - View scheduled tasks\n` +
      `/status - System information\n` +
      `/history - Conversation history stats\n` +
      `/opus - Switch to Opus 4.6\n` +
      `/sonnet - Switch to Sonnet 4.6\n` +
      `/knowledge - View stored knowledge`
  );
});

// --- Reset with confirmation ---

bot.command("reset", async (ctx) => {
  await ctx.reply(
    "Reset session and extract knowledge?",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Yes, reset", "reset_confirm"),
        Markup.button.callback("Cancel", "reset_cancel"),
      ],
    ])
  );
});

bot.action("reset_confirm", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Resetting...");
  const stopTyping = startTyping(ctx);
  try {
    if (currentSessionId) {
      await extractKnowledge(currentSessionId);
    }
    archiveCurrentSession();
    currentModel = "claude-sonnet-4-6";
    autoEscalated = false;
    await ctx.editMessageText("Session reset. Starting fresh with Sonnet 4.6.");
  } catch (err) {
    await ctx.editMessageText(
      "Reset done (knowledge extraction failed: " + err.message + ")"
    );
    archiveCurrentSession();
  } finally {
    stopTyping();
  }
});

bot.action("reset_cancel", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Reset cancelled.");
});

// --- Cancel ---

bot.command("cancel", async (ctx) => {
  if (!processing || !currentAbortController) {
    return ctx.reply("Nothing to cancel.");
  }
  currentAbortController.abort();
  await ctx.reply("Cancelling...");
});

// --- Opus with confirmation ---

bot.command("opus", async (ctx) => {
  if (currentModel === "claude-opus-4-6") {
    return ctx.reply("Already on Opus 4.6.");
  }
  await ctx.reply(
    "Switch to Opus 4.6? (higher cost per query)",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Switch to Opus", "opus_confirm"),
        Markup.button.callback("Stay on Sonnet", "opus_cancel"),
      ],
    ])
  );
});

bot.action("opus_confirm", async (ctx) => {
  await ctx.answerCbQuery();
  currentModel = "claude-opus-4-6";
  autoEscalated = false;
  await ctx.editMessageText("Switched to Opus 4.6");
});

bot.action("opus_cancel", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText("Staying on Sonnet 4.6");
});

bot.command("sonnet", (ctx) => {
  currentModel = "claude-sonnet-4-6";
  autoEscalated = false;
  ctx.reply("Switched to Sonnet 4.6");
});

// --- Schedule commands ---

bot.command("schedule", async (ctx) => {
  const text = ctx.message.text.replace(/^\/schedule\s*/, "").trim();
  if (!text) {
    return ctx.reply(
      "Tell me what to schedule in plain English.\n\n" +
        "Examples:\n" +
        "• /schedule check disk space every morning at 9am\n" +
        "• /schedule remind me about deploy every friday at 5pm\n" +
        "• /schedule run backup every sunday at 2am\n" +
        "• /schedule check server health every 30 minutes"
    );
  }

  const stopTyping = startTyping(ctx);
  try {
    const parsed = await parseScheduleWithClaude(text);
    const job = {
      id: randomUUID().slice(0, 8),
      cron: parsed.cron,
      task: parsed.task,
      description: parsed.description,
      originalText: text,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      lastResult: null,
    };

    const schedules = loadSchedules();
    schedules.push(job);
    saveSchedules(schedules);

    await ctx.reply(
      `✅ Scheduled: ${parsed.description}\nTask: ${parsed.task}\nID: ${job.id}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("❌ Remove", `unsched_${job.id}`)],
      ])
    );
  } catch (err) {
    await ctx.reply("Failed to parse schedule: " + err.message);
  } finally {
    stopTyping();
  }
});

bot.command("schedules", async (ctx) => {
  const schedules = loadSchedules();
  if (schedules.length === 0) {
    return ctx.reply(
      "No scheduled tasks. Use /schedule to create one.\n\n" +
        "Example: /schedule check disk space every morning at 9am"
    );
  }

  for (const job of schedules) {
    const status = job.enabled ? "✅" : "⏸";
    const lastRun = job.lastRun
      ? `\nLast run: ${new Date(job.lastRun).toLocaleString()}`
      : "";
    await ctx.reply(
      `${status} ${job.description}\nTask: ${job.task}\nCron: ${job.cron}\nID: ${job.id}${lastRun}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            job.enabled ? "⏸ Pause" : "▶️ Resume",
            `toggle_${job.id}`
          ),
          Markup.button.callback("❌ Delete", `unsched_${job.id}`),
        ],
      ])
    );
  }
});

bot.command("unschedule", async (ctx) => {
  const id = ctx.message.text.replace(/^\/unschedule\s*/, "").trim();
  if (!id) return ctx.reply("Usage: /unschedule <id>");

  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return ctx.reply(`Schedule ${id} not found.`);

  const removed = schedules.splice(idx, 1)[0];
  saveSchedules(schedules);
  await ctx.reply(`Removed: ${removed.description}`);
});

// Schedule inline button handlers
bot.action(/^unsched_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) {
    return ctx.editMessageText("Schedule not found (already deleted?).");
  }
  const removed = schedules.splice(idx, 1)[0];
  saveSchedules(schedules);
  await ctx.editMessageText(`Removed: ${removed.description}`);
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const id = ctx.match[1];
  const schedules = loadSchedules();
  const job = schedules.find((s) => s.id === id);
  if (!job) {
    return ctx.editMessageText("Schedule not found.");
  }
  job.enabled = !job.enabled;
  saveSchedules(schedules);

  const status = job.enabled ? "✅" : "⏸";
  const lastRun = job.lastRun
    ? `\nLast run: ${new Date(job.lastRun).toLocaleString()}`
    : "";
  await ctx.editMessageText(
    `${status} ${job.description}\nTask: ${job.task}\nCron: ${job.cron}\nID: ${job.id}${lastRun}`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          job.enabled ? "⏸ Pause" : "▶️ Resume",
          `toggle_${job.id}`
        ),
        Markup.button.callback("❌ Delete", `unsched_${job.id}`),
      ],
    ])
  );
});

// --- Status ---

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
    const schedules = loadSchedules();

    sysInfo =
      `${BOT_NAME} v${VERSION}\n` +
      `Uptime: ${hours}h ${mins}m\n` +
      `Model: ${currentModel}\n` +
      `Session: ${currentSessionId || "none"}\n` +
      `Working dir: ${WORKING_DIRECTORY}\n` +
      `Knowledge: ${knowledge.entries.length}/${MAX_KNOWLEDGE_ENTRIES} entries\n` +
      `Schedules: ${schedules.filter((s) => s.enabled).length} active / ${schedules.length} total\n\n` +
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

bot.command("knowledge", (ctx) => {
  const knowledge = loadKnowledge();
  if (knowledge.entries.length === 0) {
    return ctx.reply("No knowledge stored yet. It builds up as you use the bot.");
  }

  const permanent = knowledge.entries.filter((e) => e.importance === "permanent");
  const normal = knowledge.entries.filter((e) => e.importance !== "permanent");

  let text = "";
  if (permanent.length > 0) {
    text += "📌 Permanent:\n" + permanent.map((e) => `  [${e.category}] ${e.fact}`).join("\n");
  }
  if (normal.length > 0) {
    text += (text ? "\n\n" : "") + "📝 Normal:\n" + normal.map((e) => `  [${e.category}] ${e.fact}`).join("\n");
  }

  ctx.reply(
    `Stored knowledge (${permanent.length} permanent, ${normal.length} normal):\n\n${text}`
  );
});

// --- Message Handlers ---

bot.on("text", (ctx) =>
  withProcessingLock(ctx, async () => {
    const response = await askClaude(ctx.message.text, ctx);
    // response already sent via progress.finish() or sendResponse() inside askClaude
    // but askClaude now handles sending internally, so we don't double-send
  })
);

bot.on("photo", (ctx) =>
  withProcessingLock(ctx, async () => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const filename = `photo_${Date.now()}.jpg`;
    const filePath = await downloadTelegramFile(ctx, photo.file_id, filename);
    const caption = ctx.message.caption || "";
    const prompt = `User sent a photo (saved at ${filePath}).${caption ? ` Caption: ${caption}` : ""} Describe or process the image as needed.`;
    await askClaude(prompt, ctx);
  })
);

bot.on("document", (ctx) =>
  withProcessingLock(ctx, async () => {
    const doc = ctx.message.document;
    const filename = doc.file_name || `file_${Date.now()}`;
    const filePath = await downloadTelegramFile(ctx, doc.file_id, filename);
    const caption = ctx.message.caption || "";
    const prompt = `User sent a file: ${filename} (saved at ${filePath}, ${(doc.file_size / 1024).toFixed(1)} KB).${caption ? ` Caption: ${caption}` : ""} Process the file as needed.`;
    await askClaude(prompt, ctx);
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
    { command: "schedule", description: "Schedule a recurring task" },
    { command: "schedules", description: "View scheduled tasks" },
    { command: "unschedule", description: "Remove a scheduled task" },
    { command: "status", description: "System information" },
    { command: "history", description: "Conversation history stats" },
    { command: "opus", description: "Switch to Opus 4.6" },
    { command: "sonnet", description: "Switch to Sonnet 4.6" },
    { command: "knowledge", description: "View stored knowledge" },
  ])
  .catch((err) => console.error("Failed to set bot commands:", err.message));

startScheduler();
bot.launch();
console.log(
  `${BOT_NAME} v${VERSION} started | Model: ${currentModel} | CWD: ${WORKING_DIRECTORY}`
);

function gracefulShutdown(signal) {
  if (currentAbortController) currentAbortController.abort();
  if (scheduleTickInterval) clearInterval(scheduleTickInterval);
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
