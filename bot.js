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
  unlinkSync,
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
const MAX_KNOWLEDGE_ENTRIES = 1000;
const ARCHIVE_RETENTION_DAYS = 180;

mkdirSync(MEMORY_DIR, { recursive: true });
mkdirSync(KNOWLEDGE_DIR, { recursive: true });

// --- State ---

let currentSessionId = null;
let currentModel = "claude-sonnet-4-6";
let processing = false;
let currentAbortController = null;
let autoEscalated = false;
let currentPromptText = ""; // track what the bot is currently working on
const messageQueue = []; // queued messages waiting to run
let pendingInject = null; // message to inject into the current task

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

function cleanupArchivedSessions() {
  const cutoff = Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const files = readdirSync(MEMORY_DIR).filter((f) => f.endsWith("-archived.json"));
  let removed = 0;
  for (const f of files) {
    const filepath = join(MEMORY_DIR, f);
    const stat = statSync(filepath);
    if (stat.mtime.getTime() < cutoff) {
      unlinkSync(filepath);
      removed++;
    }
  }
  if (removed > 0) console.log(`[cleanup] Removed ${removed} archived session(s) older than ${ARCHIVE_RETENTION_DAYS} days`);
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

  const extractionPrompt = `You are a knowledge extractor. Given this conversation excerpt, extract important facts, rules, workflows and lessons worth remembering for future sessions on this server.

Current known facts:
${existingFacts}

Recent conversation:
${conversation}

Extract NEW entries not already known. Use these categories:
- "server" — server specs, OS, installed software, ports, services
- "project" — codebases, repos, tech stack, architecture decisions
- "preference" — how the user likes things done, tools they prefer
- "decision" — important choices made that affect future work
- "bug" — known issues, workarounds for specific problems
- "config" — API keys, tokens, credentials, environment variables, service configs
- "rule" — explicit corrections the user made ("no", "wrong", "never do X", "always do Y"), hard constraints, things that must never happen. Extract these even if phrased casually.
- "workflow" — successful multi-step sequences that worked well, proven approaches to recurring tasks
- "mistake" — things that failed and how they were fixed, lessons learned from errors

For each entry, assign importance:
- "permanent" — rules, credentials, core infrastructure, long-term preferences, critical lessons. Never forget these.
- "normal" — temporary context, one-off tasks, things that may become stale

Pay special attention to:
- Any correction or pushback from the user → always extract as [rule] permanent
- Any multi-step task that completed successfully → extract as [workflow]
- Any failure that was diagnosed and fixed → extract as [mistake]
- Any credential, token, or API key mentioned → extract as [config] permanent

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
3. Keep ALL "rule" category entries — these are user corrections and hard constraints, never drop them
4. Keep ALL permanent entries unless they're exact duplicates (merge those)
5. Normal entries about resolved bugs or completed one-off tasks can be dropped
6. Merge related "workflow" entries into comprehensive single workflows
7. "mistake" entries can be dropped if the same lesson is already captured as a "rule"

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

  // Critical safety rule — never self-modify
  parts.push(
    `CRITICAL: NEVER modify bot.js, package.json, ecosystem.config.cjs, setup.js, or .env in the cogent42 directory (${__dirname}). ` +
    `These files keep you running — editing them will crash you. If asked to change bot behavior, explain what the change would look like and suggest the user applies it manually or via /update.`
  );

  if (BOT_PERSONALITY) {
    parts.push(`Your personality: ${BOT_PERSONALITY}`);
  }

  const knowledge = loadKnowledge();
  if (knowledge.entries.length > 0) {
    // Sort: rules first (highest priority), then permanent, then normal
    const rules = knowledge.entries.filter((e) => e.category === "rule");
    const others = knowledge.entries.filter((e) => e.category !== "rule");
    const sorted = [...rules, ...others];

    const ruleFacts = rules.map((e) => `- ${e.fact}`).join("\n");
    const otherFacts = others.map((e) => `- [${e.category}] ${e.fact}`).join("\n");

    let memoryBlock = "";
    if (rules.length > 0) {
      memoryBlock += `RULES — always follow these, no exceptions:\n${ruleFacts}\n\n`;
    }
    if (others.length > 0) {
      memoryBlock += `Context from previous sessions:\n${otherFacts}`;
    }

    parts.push(
      `You have persistent memory from previous sessions on this server:\n\n${memoryBlock}\n\nUse this context but verify if unsure — things may have changed.`
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

// --- Processing Lock & Message Queue ---

function queueMessage(ctx, promptText, fn) {
  const id = randomUUID().slice(0, 8);
  messageQueue.push({ id, ctx, promptText, fn });
  return id;
}

async function processQueue() {
  if (processing || messageQueue.length === 0) return;
  const next = messageQueue.shift();
  await runWithLock(next.ctx, next.fn, next.promptText);
}

async function runWithLock(ctx, fn, promptText) {
  processing = true;
  currentPromptText = promptText || "";
  await reactToMessage(ctx, "👀");
  try {
    await fn();
    await reactToMessage(ctx, "✅");
  } catch (err) {
    await reactToMessage(ctx, "❌");
    if (err.name === "AbortError" || err.message?.includes("aborted")) {
      // Check if this was an inject-triggered abort
      if (pendingInject) {
        const inject = pendingInject;
        pendingInject = null;
        // Resume the session with the injected context
        const combinedPrompt =
          `[The user sent additional context while you were working on the previous task: "${inject.text}"]\n\n` +
          `Continue with what you were doing, but incorporate this new information. ` +
          `If it changes the task, adapt accordingly.`;
        processing = false;
        currentAbortController = null;
        return runWithLock(inject.ctx, async () => {
          await askClaude(combinedPrompt, inject.ctx);
        }, inject.text);
      }
      await ctx.reply("Query cancelled.");
    } else {
      console.error("Error:", err);
      await ctx.reply("Error: " + (err.message || "Unknown error"));
    }
  } finally {
    processing = false;
    currentAbortController = null;
    currentPromptText = "";
    // Auto-drain the queue
    if (messageQueue.length > 0) {
      setImmediate(processQueue);
    }
  }
}

const FOLLOWUP_PATTERNS = /^(also|and |oh wait|actually|btw|plus |don't forget|dont forget|wait |one more|oh and|fyi|note:|heads up|correction|change that|instead |use |not |no,|no |switch to|make sure)/i;

function looksLikeFollowup(text) {
  if (!text) return false;
  if (text.length > 120) return false;
  if (text.startsWith("/")) return false; // commands are never followups
  if (FOLLOWUP_PATTERNS.test(text.trim())) return true;
  if (text.length < 40) return true; // very short messages are almost always context
  return false;
}

async function withProcessingLock(ctx, fn, promptText) {
  if (!processing) {
    return runWithLock(ctx, fn, promptText);
  }

  // Bot is busy — check if this looks like a quick follow-up
  if (looksLikeFollowup(promptText)) {
    // Auto-inject: react with ⚡ and inject silently
    try {
      await ctx.telegram.setMessageReaction(
        ctx.chat.id,
        ctx.message.message_id,
        [{ type: "emoji", emoji: "⚡" }]
      );
    } catch {}
    pendingInject = { ctx, text: promptText };
    currentAbortController?.abort();
    return;
  }

  // Longer message — offer inject or queue buttons
  const id = queueMessage(ctx, promptText, fn);
  const pos = messageQueue.length;
  const preview = (promptText || "").slice(0, 50);
  const currentPreview = currentPromptText.slice(0, 60);

  await ctx.reply(
    `I'm currently working on:\n<i>${escapeHtml(currentPreview)}${currentPromptText.length > 60 ? "…" : ""}</i>\n\n` +
    `Your new message:\n<i>${escapeHtml(preview)}${(promptText || "").length > 50 ? "…" : ""}</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("⚡ Inject now", `inject_${id}`),
          Markup.button.callback(`📥 Queue (#${pos})`, `keep_${id}`),
        ],
      ]),
    }
  );
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

    // Trigger immediate extraction on corrections — don't wait for the interval
    const CORRECTION_SIGNALS = [
      "no no", "wrong", "not like that", "never do", "never again",
      "always do", "don't do", "stop doing", "actually,", "actually -",
      "that's wrong", "thats wrong", "incorrect", "redo", "you forgot",
      "i already told", "i told you", "keep this in memory", "remember this",
      "force push", "never force",
    ];
    const isCorrection = CORRECTION_SIGNALS.some((s) =>
      prompt.toLowerCase().includes(s)
    );

    if (isCorrection) {
      extractKnowledge(sessionId).catch((err) =>
        console.error("Correction-triggered extraction failed:", err.message)
      );
    } else if (session.turnCount > 0 && session.turnCount % EXTRACTION_INTERVAL === 0) {
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

// --- Inject / Queue Actions ---

bot.action(/^inject_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Injecting…");
  const id = ctx.match[1];
  const idx = messageQueue.findIndex((q) => q.id === id);

  if (idx === -1) {
    return ctx.editMessageText("Already processed.");
  }

  const item = messageQueue.splice(idx, 1)[0];

  // React to the original message with ⚡ so user knows it was injected
  try {
    await ctx.telegram.setMessageReaction(
      item.ctx.chat.id,
      item.ctx.message.message_id,
      [{ type: "emoji", emoji: "⚡" }]
    );
  } catch {}

  // Delete the inject/queue prompt message — keep chat clean
  try {
    await ctx.deleteMessage();
  } catch {}

  if (!processing) {
    runWithLock(item.ctx, item.fn, item.promptText);
    return;
  }

  // Set as pending inject and abort current task
  pendingInject = { ctx: item.ctx, text: item.promptText };
  currentAbortController?.abort();
});

bot.action(/^keep_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery("Queued");
  const id = ctx.match[1];
  const item = messageQueue.find((q) => q.id === id);

  // React to the original message with 📥 so user knows it's queued
  if (item) {
    try {
      await ctx.telegram.setMessageReaction(
        item.ctx.chat.id,
        item.ctx.message.message_id,
        [{ type: "emoji", emoji: "📥" }]
      );
    } catch {}
  }

  // Delete the inject/queue prompt message — keep chat clean
  try {
    await ctx.deleteMessage();
  } catch {}
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
  pendingInject = null; // clear any pending inject so abort is a real cancel
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

bot.command("knowledge", async (ctx) => {
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

  const full = `Stored knowledge (${permanent.length} permanent, ${normal.length} normal):\n\n${text}`;
  for (let i = 0; i < full.length; i += 4000) {
    await ctx.reply(full.slice(i, i + 4000));
  }
});

bot.command("update", async (ctx) => {
  const botDir = __dirname;
  const run = (cmd) => execSync(cmd, { cwd: botDir, timeout: 120000 }).toString().trim();

  try {
    ctx.reply("Checking for updates...");

    // Check if there are new commits
    run("git fetch origin main");
    const behind = run("git rev-list HEAD..origin/main --count");
    if (behind === "0") {
      return ctx.reply("Already up to date!");
    }

    ctx.reply(`${behind} new commit(s) found. Updating...`);

    // Discard local bot.js changes (self-modifications from Claude) and pull clean
    try {
      run("git checkout -- bot.js");
    } catch { /* no local changes to bot.js, that's fine */ }

    // Stash remaining local changes (e.g. package-lock.json)
    const hasLocalChanges = run("git status --porcelain") !== "";
    if (hasLocalChanges) {
      run("git stash --include-untracked");
    }

    // Pull latest code
    try {
      run("git pull origin main");
    } catch (pullErr) {
      if (hasLocalChanges) try { run("git stash pop"); } catch {}
      return ctx.reply(`Update failed during git pull: ${pullErr.message}`);
    }

    // Restore stashed changes — if conflicts, drop stash and use clean repo version
    if (hasLocalChanges) {
      try {
        run("git stash pop");
      } catch {
        run("git checkout -- .");
        run("git stash drop");
        ctx.reply("Local changes conflicted with update — using clean repo version. Your .env is safe.");
      }
    }

    // Install dependencies in case they changed
    try {
      run("npm install --omit=dev");
    } catch {
      ctx.reply("Warning: npm install had issues. Bot will still attempt restart.");
    }

    // Detect PM2 and restart safely
    let usingPM2 = false;
    try {
      const pm2List = run("pm2 jlist");
      const apps = JSON.parse(pm2List);
      usingPM2 = apps.some((a) => a.name === "cogent42" && a.pm2_env?.status === "online");
    } catch {
      // pm2 not available or not managing this bot
    }

    if (usingPM2) {
      await ctx.reply("Update complete. Restarting via PM2...");
      // Small delay to ensure the message is sent before restart
      setTimeout(() => {
        try { execSync("pm2 restart cogent42", { cwd: botDir }); } catch { process.exit(0); }
      }, 1000);
    } else {
      await ctx.reply("Update complete. Restarting...");
      setTimeout(() => process.exit(0), 1000);
    }
  } catch (err) {
    ctx.reply(`Update failed: ${err.message}`);
  }
});

// --- Message Handlers ---

bot.on("text", (ctx) => {
  const text = ctx.message.text;
  withProcessingLock(ctx, async () => {
    await askClaude(text, ctx);
  }, text);
});

bot.on("photo", (ctx) => {
  const caption = ctx.message.caption || "";
  withProcessingLock(ctx, async () => {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const filename = `photo_${Date.now()}.jpg`;
    const filePath = await downloadTelegramFile(ctx, photo.file_id, filename);
    const prompt = `User sent a photo (saved at ${filePath}).${caption ? ` Caption: ${caption}` : ""} Describe or process the image as needed.`;
    await askClaude(prompt, ctx);
  }, caption || "photo");
});

bot.on("document", (ctx) => {
  const doc = ctx.message.document;
  const caption = ctx.message.caption || "";
  withProcessingLock(ctx, async () => {
    const filename = doc.file_name || `file_${Date.now()}`;
    const filePath = await downloadTelegramFile(ctx, doc.file_id, filename);
    const prompt = `User sent a file: ${filename} (saved at ${filePath}, ${(doc.file_size / 1024).toFixed(1)} KB).${caption ? ` Caption: ${caption}` : ""} Process the file as needed.`;
    await askClaude(prompt, ctx);
  }, caption || doc.file_name || "document");
});

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
    { command: "update", description: "Update bot to latest version" },
  ])
  .catch((err) => console.error("Failed to set bot commands:", err.message));

cleanupArchivedSessions();
startScheduler();
bot.catch((err, ctx) => {
  console.error("Telegraf error:", err.message);
});
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
