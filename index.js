import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { registerGeneralHandlers } from "./general_wp.js";
import { registerConnectionHandlers } from "./connection_wp.js";

function findChrome() {
  const isARM = process.arch === "arm64" || process.arch === "arm";
  const isLinux = process.platform === "linux";

  if (!isLinux || !isARM) {
    return undefined;
  }

  const paths = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
    "/usr/lib64/chromium-browser/chromium-browser",
    "/usr/lib/chromium-browser/chromium-browser",
  ];

  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        console.log(`Using system browser: ${p}`);
        return p;
      }
    } catch (e) {}
  }

  console.log("No system browser found. Install chromium for ARM Linux.");
  return undefined;
}

const chromePath = findChrome();

const db = new Database("./messages.db");

db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender_name TEXT,
        body TEXT,
        type TEXT DEFAULT 'chat',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_body ON messages(body);

    CREATE TABLE IF NOT EXISTS chat_state (
      chat_id TEXT PRIMARY KEY,
      last_reset_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );
`);

const insertChat = db.prepare(`
    INSERT OR REPLACE INTO chats (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
`);

const insertMessage = db.prepare(`
    INSERT INTO messages (chat_id, sender_name, body, type) VALUES (?, ?, ?, ?)
`);

const getChats = db.prepare(`
    SELECT
      c.id,
      c.name,
      COUNT(m.id) as message_count,
      COALESCE(
        SUM(
          CASE
            WHEN m.type != 'outgoing' AND m.timestamp > COALESCE(s.last_reset_at, '1970-01-01 00:00:00')
            THEN 1
            ELSE 0
          END
        ),
        0
      ) as new_incoming_count
    FROM chats c
    LEFT JOIN messages m ON c.id = m.chat_id
    LEFT JOIN chat_state s ON s.chat_id = c.id
    GROUP BY c.id
    ORDER BY c.updated_at DESC
    LIMIT 20
`);

const getMessages = db.prepare(`
    SELECT sender_name, body, type, timestamp
    FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
`);

const searchMessages = db.prepare(`
    SELECT c.name as chat_name, c.id as chat_id, m.body, m.timestamp, m.sender_name
    FROM messages m
    JOIN chats c ON m.chat_id = c.id
    WHERE m.body LIKE ?
    ORDER BY m.timestamp DESC
    LIMIT 15
`);

const getChatByIdFromDb = db.prepare(`
  SELECT name FROM chats WHERE id = ?
`);

const resetChatState = db.prepare(`
  INSERT OR REPLACE INTO chat_state (chat_id, last_reset_at)
  VALUES (?, CURRENT_TIMESTAMP)
`);

const resetAllChatStates = db.prepare(`
  INSERT OR REPLACE INTO chat_state (chat_id, last_reset_at)
  SELECT id, CURRENT_TIMESTAMP FROM chats
`);

const getChatStats = db.prepare(`
    SELECT COUNT(*) as total_messages, COUNT(DISTINCT chat_id) as total_chats FROM messages
`);

function escapeMarkdown(text) {
  if (!text) return "";
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, "\\$&");
}

function formatMessage(message, contact, chat) {
  const senderName = contact?.pushname || contact?.name || message.from;
  const chatName = chat?.name || "Private Chat";
  const isGroup = chat?.isGroup;
  const chatId = message.from;

  let header = isGroup
    ? `WhatsApp Group: ${escapeMarkdown(chatName)}\nFrom: ${escapeMarkdown(senderName)}`
    : `WhatsApp from: ${escapeMarkdown(senderName)}`;

  header += `\nID: \`${chatId}\``;

  return `${header}\n\n${escapeMarkdown(message.body)}`;
}

function ensureBotConfigDir() {
  const dir = path.resolve("./bots");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function loadBotConfigs() {
  const botDir = ensureBotConfigDir();
  const files = fs
    .readdirSync(botDir)
    .filter((f) => f.endsWith(".json") && f !== "example.bot.json");

  const configs = [];

  for (const file of files) {
    const fullPath = path.join(botDir, file);
    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!parsed.token || !parsed.chatId) {
        console.log(`Skipping ${file}: token or chatId missing`);
        continue;
      }

      configs.push({
        id: path.basename(file, ".json"),
        name: parsed.name || path.basename(file, ".json"),
        token: String(parsed.token).trim(),
        chatId: String(parsed.chatId).trim(),
        mode: parsed.mode === "connection" ? "connection" : "general",
      });
    } catch (error) {
      console.error(`Failed to load ${file}:`, error.message);
    }
  }

  if (configs.length === 0) {
    console.error("No Telegram bot config found.");
    console.error(
      "Create bot files under bots/*.json (see bots/example.bot.json). .env is not used.",
    );
    process.exit(1);
  }

  const tokenOwners = new Map();
  const duplicates = [];
  for (const cfg of configs) {
    const owner = tokenOwners.get(cfg.token);
    if (owner) {
      duplicates.push(`${owner} <-> ${cfg.name}`);
    } else {
      tokenOwners.set(cfg.token, cfg.name);
    }
  }

  if (duplicates.length > 0) {
    console.error("Duplicate Telegram bot token detected across configs.");
    console.error(
      "Each bot must use a different token when polling is enabled.",
    );
    for (const pair of duplicates) {
      console.error(`Token conflict: ${pair}`);
    }
    process.exit(1);
  }

  return configs;
}

const botRuntimes = [];

function createRuntime(config) {
  return {
    config,
    bot: new TelegramBot(config.token, { polling: true }),
    lastWhatsAppChat: null,
    activeConnection: null,
    messageMap: new Map(),
  };
}

function setupBotHandlers(runtime) {
  if (runtime.config.mode === "connection") {
    registerConnectionHandlers({
      runtime,
      whatsappClient,
      resolveChatConnection,
      escapeMarkdown,
      recordOutgoingMessage,
    });
    return;
  }

  registerGeneralHandlers({
    runtime,
    whatsappClient,
    db,
    getChats,
    getChatStats,
    getMessages,
    searchMessages,
    escapeMarkdown,
    recordOutgoingMessage,
    resetChatState,
    resetAllChatStates,
  });
}

async function recordOutgoingMessage(
  chatId,
  body,
  senderName = "Telegram User",
) {
  if (!chatId || body == null) {
    return;
  }

  const text = String(body).trim();
  if (!text) {
    return;
  }

  let chatName = chatId;
  try {
    const chat = await whatsappClient.getChatById(chatId);
    chatName = chat?.name || chatId;
  } catch (error) {
    const existing = getChatByIdFromDb.get(chatId);
    chatName = existing?.name || chatId;
  }

  insertChat.run(chatId, chatName);
  insertMessage.run(chatId, senderName, text, "outgoing");
  resetChatState.run(chatId);
}

async function sendToRuntime(
  runtime,
  text,
  whatsappChatId = null,
  options = {},
) {
  const chatId = runtime.config.chatId;
  try {
    const sentMessage = await runtime.bot.sendMessage(chatId, text, {
      parse_mode: "MarkdownV2",
      ...options,
    });

    if (whatsappChatId && sentMessage.message_id) {
      runtime.messageMap.set(sentMessage.message_id, whatsappChatId);
      if (runtime.messageMap.size > 1000) {
        const firstKey = runtime.messageMap.keys().next().value;
        runtime.messageMap.delete(firstKey);
      }
    }

    return sentMessage;
  } catch (error) {
    try {
      const sentMessage = await runtime.bot.sendMessage(
        chatId,
        text.replace(/\\/g, ""),
        {},
      );
      if (whatsappChatId && sentMessage.message_id) {
        runtime.messageMap.set(sentMessage.message_id, whatsappChatId);
      }
      return sentMessage;
    } catch (e) {
      console.error(`Send failed for bot ${runtime.config.name}:`, e.message);
      return null;
    }
  }
}

function isRuntimeEligibleForChat(runtime, whatsappChatId) {
  if (!whatsappChatId) {
    return true;
  }

  if (runtime.config.mode !== "connection") {
    return true;
  }

  return runtime.activeConnection?.id === whatsappChatId;
}

async function sendToAllBots(text, whatsappChatId = null, options = {}) {
  await Promise.all(
    botRuntimes
      .filter((runtime) => isRuntimeEligibleForChat(runtime, whatsappChatId))
      .map((runtime) => sendToRuntime(runtime, text, whatsappChatId, options)),
  );
}

async function sendMediaToRuntime(
  runtime,
  mediaBuffer,
  mimeType,
  caption,
  whatsappChatId = null,
) {
  const chatId = runtime.config.chatId;
  let sentMessage = null;

  if (mimeType.startsWith("image/")) {
    sentMessage = await runtime.bot.sendPhoto(chatId, mediaBuffer, {
      caption: caption.replace(/\\/g, ""),
    });
  } else if (mimeType.startsWith("video/")) {
    sentMessage = await runtime.bot.sendVideo(chatId, mediaBuffer, {
      caption: caption.replace(/\\/g, ""),
    });
  } else if (mimeType.startsWith("audio/")) {
    sentMessage = await runtime.bot.sendAudio(chatId, mediaBuffer, {
      caption: caption.replace(/\\/g, ""),
    });
  } else {
    sentMessage = await runtime.bot.sendDocument(chatId, mediaBuffer, {
      caption: caption.replace(/\\/g, ""),
    });
  }

  if (whatsappChatId && sentMessage && sentMessage.message_id) {
    runtime.messageMap.set(sentMessage.message_id, whatsappChatId);
  }
}

async function sendMediaToAllBots(message, caption, whatsappChatId = null) {
  try {
    const media = await message.downloadMedia();
    if (!media) {
      await sendToAllBots(
        caption + "\n\n_[Media could not be downloaded]_",
        whatsappChatId,
      );
      return;
    }

    const buffer = Buffer.from(media.data, "base64");
    const mimeType = media.mimetype;

    for (const runtime of botRuntimes) {
      if (!isRuntimeEligibleForChat(runtime, whatsappChatId)) {
        continue;
      }

      try {
        await sendMediaToRuntime(
          runtime,
          buffer,
          mimeType,
          caption,
          whatsappChatId,
        );
      } catch (error) {
        await sendToRuntime(
          runtime,
          caption + "\n\n_[Media failed to send]_",
          whatsappChatId,
        );
      }
    }
  } catch (error) {
    console.error("Media processing failed:", error.message);
  }
}

async function resolveChatConnection(targetType, query) {
  const normalizedQuery = (query || "").trim().toLowerCase();
  const wantsGroup = targetType === "group";

  if (!normalizedQuery) {
    return null;
  }

  const chats = await whatsappClient.getChats();
  const filtered = chats.filter((c) => (wantsGroup ? c.isGroup : !c.isGroup));

  const exact = filtered.find((c) => {
    const chatName = (c.name || "").trim().toLowerCase();
    return chatName === normalizedQuery || c.id?._serialized === query;
  });

  if (exact) return exact;

  return filtered.find((c) => {
    const chatName = (c.name || "").trim().toLowerCase();
    return chatName.includes(normalizedQuery);
  });
}

const whatsappClient = new Client({
  authStrategy: new LocalAuth({
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    ...(chromePath && { executablePath: chromePath }),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-extensions",
    ],
  },
});

whatsappClient.on("qr", (qr) => {
  console.log("\nScan this QR code with WhatsApp to login:\n");
  qrcode.generate(qr, { small: true });
});

whatsappClient.on("loading_screen", (percent, message) => {
  console.log(`Loading: ${percent}% - ${message}`);
});

whatsappClient.on("authenticated", () => {
  console.log("WhatsApp authenticated");
});

whatsappClient.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
});

whatsappClient.on("ready", async () => {
  console.log("\nWhatsApp Web is ready!");
  console.log(
    "Messages will now be forwarded to all configured Telegram bots\n",
  );
  await sendToAllBots("*WhatsApp to Telegram Bridge is now active*", null, {
    parse_mode: "MarkdownV2",
  });
});

whatsappClient.on("disconnected", (reason) => {
  console.log("WhatsApp disconnected:", reason);
});

whatsappClient.on("message", async (message) => {
  try {
    if (message.isStatus || message.from === "status@broadcast") {
      return;
    }

    const contact = await message.getContact();
    const chat = await message.getChat();

    for (const runtime of botRuntimes) {
      runtime.lastWhatsAppChat = message.from;
    }

    const chatId = message.from;
    const chatName = chat?.name || contact?.pushname || contact?.name || chatId;
    const senderName = contact?.pushname || contact?.name || "Unknown";

    insertChat.run(chatId, chatName);
    insertMessage.run(chatId, senderName, message.body || "", message.type);

    const caption = formatMessage(message, contact, chat);
    const whatsappChatId = message.from;

    if (message.hasMedia) {
      await sendMediaToAllBots(message, caption, whatsappChatId);
    } else if (message.type === "chat") {
      await sendToAllBots(caption, whatsappChatId);
    } else if (message.type === "location") {
      const locationText =
        caption +
        `\n\nLocation: ${message.location.latitude}, ${message.location.longitude}`;
      await sendToAllBots(locationText, whatsappChatId);
    } else if (message.type === "vcard" || message.type === "multi_vcard") {
      await sendToAllBots(
        caption + "\n\n_[Contact card received]_",
        whatsappChatId,
      );
    } else {
      await sendToAllBots(
        caption + `\n\n_[${message.type} message]_`,
        whatsappChatId,
      );
    }
  } catch (error) {
    console.error("Error processing message:", error.message);
  }
});

whatsappClient.on("group_join", async (notification) => {
  const chat = await notification.getChat();
  await sendToAllBots(`Someone joined group: *${escapeMarkdown(chat.name)}*`);
});

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await sendToAllBots("*WhatsApp to Telegram Bridge is shutting down*");

  for (const runtime of botRuntimes) {
    runtime.bot.stopPolling();
  }

  await whatsappClient.destroy();
  process.exit(0);
});

const botConfigs = loadBotConfigs();
for (const config of botConfigs) {
  const runtime = createRuntime(config);
  botRuntimes.push(runtime);
  setupBotHandlers(runtime);
}

console.log(`Starting bridge with ${botRuntimes.length} Telegram bot(s)...`);
for (const runtime of botRuntimes) {
  console.log(
    `- ${runtime.config.name} [${runtime.config.mode}] (chatId: ${runtime.config.chatId})`,
  );
}

whatsappClient.initialize();
