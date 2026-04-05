import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, r));

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function banner() {
  console.log(`
${BOLD}${CYAN}
   ██████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗  ██╗██████╗
  ██╔════╝██╔═══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║  ██║╚════██╗
  ██║     ██║   ██║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ███████║ █████╔╝
  ██║     ██║   ██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚════██║██╔═══╝
  ╚██████╗╚██████╔╝╚██████╔╝███████╗██║ ╚████║   ██║        ██║███████╗
   ╚═════╝ ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═╝╚══════╝
${RESET}
${DIM}  Full Claude Code access to your server via Telegram — cogent42${RESET}
`);
}

function step(n, text) {
  console.log(`\n${BOLD}${GREEN}[${n}]${RESET} ${BOLD}${text}${RESET}`);
}

function info(text) {
  console.log(`    ${DIM}${text}${RESET}`);
}

function success(text) {
  console.log(`    ${GREEN}${text}${RESET}`);
}

function warn(text) {
  console.log(`    ${YELLOW}${text}${RESET}`);
}

async function checkNodeVersion() {
  step(1, "Checking Node.js version");
  const version = process.version;
  const major = parseInt(version.slice(1).split(".")[0], 10);

  if (major < 18) {
    warn(`Node.js ${version} detected. Version 18+ is required.`);
    info("Install via: https://nodejs.org or use nvm:");
    info("  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash");
    info("  nvm install 22");
    info("  nvm use 22");

    const cont = await ask(`\n    Continue anyway? (y/N): `);
    if (cont.toLowerCase() !== "y") {
      console.log("\nSetup aborted. Install Node.js 18+ and try again.");
      process.exit(1);
    }
  } else {
    success(`Node.js ${version} - OK`);
  }
}

async function installDependencies() {
  step(2, "Installing dependencies");
  try {
    execSync("npm install", { cwd: __dirname, stdio: "inherit" });
    success("Dependencies installed");
  } catch {
    warn("npm install failed. Try running it manually.");
  }
}

async function setupEnv() {
  step(3, "Setting up environment variables");

  const envPath = join(__dirname, ".env");
  const examplePath = join(__dirname, ".env.example");

  if (existsSync(envPath)) {
    const overwrite = await ask("    .env file already exists. Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      success("Keeping existing .env file");
      return;
    }
  }

  console.log();
  info("You'll need:");
  info("  1. A Telegram Bot Token (from @BotFather on Telegram)");
  info("  2. Your Telegram User ID (from @userinfobot on Telegram)");
  info("  3. Claude Code CLI authenticated (just run 'claude' and sign in)");
  console.log();

  const botToken = await ask(`    ${BOLD}Telegram Bot Token:${RESET} `);
  const userId = await ask(`    ${BOLD}Telegram User ID:${RESET} `);
  const workDir = await ask(
    `    ${BOLD}Working directory${RESET} ${DIM}(default: /root):${RESET} `
  );
  const maxTurns = await ask(
    `    ${BOLD}Max turns per query${RESET} ${DIM}(default: 25):${RESET} `
  );

  console.log();
  info("Bot identity (optional):");
  const botName = await ask(
    `    ${BOLD}Bot name${RESET} ${DIM}(default: cogent42):${RESET} `
  );
  const botPersonality = await ask(
    `    ${BOLD}Bot personality${RESET} ${DIM}(optional — e.g. "concise and direct" or blank to skip):${RESET} `
  );

  const env = [
    `TELEGRAM_BOT_TOKEN=${botToken}`,
    `TELEGRAM_USER_ID=${userId}`,
    `MAX_TURNS=${maxTurns || "25"}`,
    `WORKING_DIRECTORY=${workDir || "/root"}`,
    `BOT_NAME=${botName || "cogent42"}`,
    `BOT_PERSONALITY=${botPersonality || ""}`,
  ].join("\n");

  writeFileSync(envPath, env + "\n");
  success(".env file created");
}

async function checkClaudeCode() {
  step(4, "Checking Claude Code CLI");

  let cliInstalled = false;
  try {
    execSync("claude --version", { stdio: "pipe" });
    success("Claude Code CLI is installed");
    cliInstalled = true;
  } catch {
    warn("Claude Code CLI is not installed. The SDK requires it.");
    info("Install it with: npm install -g @anthropic-ai/claude-code");
    const install = await ask("    Install Claude Code CLI globally? (Y/n): ");
    if (install.toLowerCase() !== "n") {
      try {
        execSync("npm install -g @anthropic-ai/claude-code", { stdio: "inherit" });
        success("Claude Code CLI installed");
        cliInstalled = true;
      } catch {
        warn("Failed to install. Try: sudo npm install -g @anthropic-ai/claude-code");
      }
    }
  }

  if (cliInstalled) {
    info("Make sure Claude Code is authenticated with your subscription.");
    info("If you haven't yet, run: claude");
    info("It will open a browser to sign in with your Claude account.");
  }
}

async function checkPm2() {
  step(5, "Checking PM2");

  try {
    execSync("pm2 --version", { stdio: "pipe" });
    success("PM2 is installed");
  } catch {
    info("PM2 is not installed. It keeps the bot running and auto-restarts on crash.");
    const install = await ask("    Install PM2 globally? (Y/n): ");
    if (install.toLowerCase() !== "n") {
      try {
        execSync("npm install -g pm2", { stdio: "inherit" });
        success("PM2 installed");
      } catch {
        warn("Failed to install PM2. Try: sudo npm install -g pm2");
      }
    }
  }
}

async function startBot() {
  step(6, "Starting cogent42");

  console.log();
  info("How would you like to run the bot?");
  console.log(`    ${BOLD}1${RESET} - PM2 (recommended — auto-restarts, logs, survives reboots)`);
  console.log(`    ${BOLD}2${RESET} - Foreground (for testing)`);
  console.log(`    ${BOLD}3${RESET} - Don't start yet`);

  const choice = await ask(`\n    Choice (1/2/3): `);

  if (choice === "1") {
    try {
      execSync("pm2 start ecosystem.config.cjs", { cwd: __dirname, stdio: "inherit" });
      console.log();
      success("cogent42 is running!");
      info("Useful commands:");
      info("  pm2 logs cogent42    - View logs");
      info("  pm2 status           - Check status");
      info("  pm2 restart cogent42 - Restart");
      info("  pm2 stop cogent42    - Stop");
      info("  pm2 save           - Save process list for reboot survival");
      info("  pm2 startup        - Generate startup script");
    } catch {
      warn("PM2 start failed. Try: pm2 start ecosystem.config.cjs");
    }
  } else if (choice === "2") {
    console.log();
    info("Starting in foreground... Press Ctrl+C to stop.");
    console.log();
    rl.close();
    await import("./bot.js");
    return;
  } else {
    console.log();
    info("To start later:");
    info("  pm2 start ecosystem.config.cjs   (background)");
    info("  node bot.js                       (foreground)");
  }
}

async function main() {
  banner();

  await checkNodeVersion();
  await installDependencies();
  await setupEnv();
  await checkClaudeCode();
  await checkPm2();
  await startBot();

  console.log(`\n${BOLD}${GREEN}Setup complete!${RESET}`);
  info("Open Telegram and message your bot to get started.\n");
  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
