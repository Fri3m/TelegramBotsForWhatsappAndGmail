import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import TelegramBot from "node-telegram-bot-api";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { registerGeneralHandlers } from "./general_wp.js";
import { registerConnectionHandlers } from "./connection_wp.js";
import { registerEmailHandlers } from "./email_wp.js";

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

    CREATE TABLE IF NOT EXISTS media_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_name TEXT,
      message_type TEXT,
      mime_type TEXT,
      file_path TEXT,
      file_size INTEGER,
      caption TEXT,
      stored INTEGER DEFAULT 1,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

    CREATE INDEX IF NOT EXISTS idx_media_files_chat_id ON media_files(chat_id);
    CREATE INDEX IF NOT EXISTS idx_media_files_timestamp ON media_files(timestamp);
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

const insertMediaFile = db.prepare(`
  INSERT INTO media_files (
    chat_id,
    sender_name,
    message_type,
    mime_type,
    file_path,
    file_size,
    caption,
    stored
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const getMediaFilesOlderThanOneWeek = db.prepare(`
  SELECT id, file_path
  FROM media_files
  WHERE stored = 1
    AND timestamp < datetime('now', '-7 day')
`);

const deleteMediaRecordsOlderThanOneWeek = db.prepare(`
  DELETE FROM media_files
  WHERE timestamp < datetime('now', '-7 day')
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

function loadMediaStorageRules() {
  const defaults = {
    skipMediaStorageChatIds: [],
    skipMediaStorageNamePatterns: [],
  };

  const rulesPath = path.resolve("./media-rules.json");
  if (!fs.existsSync(rulesPath)) {
    return defaults;
  }

  try {
    const raw = fs.readFileSync(rulesPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      skipMediaStorageChatIds: Array.isArray(parsed.skipMediaStorageChatIds)
        ? parsed.skipMediaStorageChatIds.map((x) => String(x).trim())
        : [],
      skipMediaStorageNamePatterns: Array.isArray(
        parsed.skipMediaStorageNamePatterns,
      )
        ? parsed.skipMediaStorageNamePatterns
            .map((x) => String(x).trim())
            .filter(Boolean)
        : [],
    };
  } catch (error) {
    console.error("Failed to parse media-rules.json, using defaults.");
    return defaults;
  }
}

function saveMediaStorageRules(rules) {
  const rulesPath = path.resolve("./media-rules.json");
  const payload = {
    skipMediaStorageChatIds: Array.isArray(rules.skipMediaStorageChatIds)
      ? Array.from(new Set(rules.skipMediaStorageChatIds.map((x) => String(x).trim()))).filter(Boolean)
      : [],
    skipMediaStorageNamePatterns: Array.isArray(rules.skipMediaStorageNamePatterns)
      ? Array.from(
          new Set(rules.skipMediaStorageNamePatterns.map((x) => String(x).trim())),
        ).filter(Boolean)
      : [],
  };

  fs.writeFileSync(rulesPath, JSON.stringify(payload, null, 2), "utf-8");
}

function ensureMediaDir() {
  const mediaDir = path.resolve("./media");
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
  return mediaDir;
}

function sanitizeFilePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9._-]/g, "_");
}

function getExtensionFromMime(mimeType) {
  if (!mimeType) return "bin";
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  };

  if (map[mimeType]) {
    return map[mimeType];
  }

  const slashIndex = mimeType.indexOf("/");
  return slashIndex > -1 ? mimeType.substring(slashIndex + 1) : "bin";
}

const mediaStorageRules = loadMediaStorageRules();
const mediaRootDir = ensureMediaDir();

function banMediaStorageForChatId(chatId) {
  const normalized = String(chatId || "").trim();
  if (!normalized) {
    return { ok: false, reason: "empty-id" };
  }

  if (!mediaStorageRules.skipMediaStorageChatIds.includes(normalized)) {
    mediaStorageRules.skipMediaStorageChatIds.push(normalized);
    saveMediaStorageRules(mediaStorageRules);
    return { ok: true, added: true, id: normalized };
  }

  return { ok: true, added: false, id: normalized };
}

function shouldSkipMediaStorage(chatId, chatName) {
  if (mediaStorageRules.skipMediaStorageChatIds.includes(chatId)) {
    return true;
  }

  const normalizedName = String(chatName || "").toLocaleLowerCase("tr-TR");
  return mediaStorageRules.skipMediaStorageNamePatterns.some((pattern) =>
    normalizedName.includes(pattern.toLocaleLowerCase("tr-TR")),
  );
}

async function saveIncomingMediaToStorage(message, chatId) {
  const media = await message.downloadMedia();
  if (!media?.data) {
    return null;
  }

  const dateFolder = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(mediaRootDir, dateFolder);
  if (!fs.existsSync(dayDir)) {
    fs.mkdirSync(dayDir, { recursive: true });
  }

  const ext = getExtensionFromMime(media.mimetype);
  const fileName = `${Date.now()}_${sanitizeFilePart(chatId)}.${ext}`;
  const absolutePath = path.join(dayDir, fileName);
  const relativePath = path.relative(path.resolve("."), absolutePath);

  const buffer = Buffer.from(media.data, "base64");
  fs.writeFileSync(absolutePath, buffer);

  return {
    absolutePath,
    relativePath,
    mimeType: media.mimetype,
    fileSize: buffer.length,
  };
}

function runDailyMediaCleanup() {
  try {
    const oldRows = getMediaFilesOlderThanOneWeek.all();
    for (const row of oldRows) {
      if (!row.file_path) continue;
      const absolutePath = path.resolve(".", row.file_path);
      if (fs.existsSync(absolutePath)) {
        try {
          fs.unlinkSync(absolutePath);
        } catch (error) {
          console.error(`Failed to delete media file ${absolutePath}:`, error.message);
        }
      }
    }

    const result = deleteMediaRecordsOlderThanOneWeek.run();
    if (oldRows.length > 0 || result.changes > 0) {
      console.log(`Daily media cleanup: removed ${result.changes} media DB row(s).`);
    }
  } catch (error) {
    console.error("Daily media cleanup failed:", error.message);
  }
}

function scheduleDailyMediaCleanupAtMidnight() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const firstDelay = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    runDailyMediaCleanup();
    setInterval(runDailyMediaCleanup, 24 * 60 * 60 * 1000);
  }, firstDelay);
}

function loadBotConfigs() {
  const botDir = ensureBotConfigDir();
  const files = fs
    .readdirSync(botDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("example."));

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

      const mode =
        parsed.mode === "connection"
          ? "connection"
          : parsed.mode === "email"
            ? "email"
            : "general";

      configs.push({
        id: path.basename(file, ".json"),
        name: parsed.name || path.basename(file, ".json"),
        token: String(parsed.token).trim(),
        chatId: String(parsed.chatId).trim(),
        mode,
        email_accounts: Array.isArray(parsed.email_accounts)
          ? parsed.email_accounts
              .map((item) => ({
                name: String(item?.name || item?.email || "").trim(),
                email: String(item?.email || "").trim(),
                password: String(item?.password || "").replace(/\s+/g, ""),
              }))
              .filter((item) => item.email && item.password)
          : [],
        gmail_email: parsed.gmail_email
          ? String(parsed.gmail_email).trim()
          : "",
        gmail_password: parsed.gmail_password
          ? String(parsed.gmail_password).replace(/\s+/g, "")
          : "",
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
  const runtime = {
    config,
    bot: new TelegramBot(config.token, { polling: true }),
    lastWhatsAppChat: null,
    activeConnection: null,
    messageMap: new Map(),
  };

  if (config.mode === "email") {
    const accounts = [];

    if (Array.isArray(config.email_accounts)) {
      for (const item of config.email_accounts) {
        if (!item) continue;
        const email = String(item.email || "").trim();
        const password = String(item.password || "").replace(/\s+/g, "");
        const name = String(item.name || email).trim();
        if (!email || !password) continue;
        accounts.push({ email, password, name });
      }
    }

    // Backward compatibility: single account fields.
    const singleEmail = String(config.gmail_email || "").trim();
    const singlePassword = String(config.gmail_password || "").replace(
      /\s+/g,
      "",
    );
    if (singleEmail && singlePassword) {
      accounts.push({
        email: singleEmail,
        password: singlePassword,
        name: singleEmail,
      });
    }

    const deduped = new Map();
    for (const account of accounts) {
      if (!deduped.has(account.email)) {
        deduped.set(account.email, account);
      }
    }

    runtime.emailConfig = {
      accounts: Array.from(deduped.values()),
    };
  }

  return runtime;
}

function setupBotHandlers(runtime) {
  if (runtime.config.mode === "email") {
    if (!runtime.emailConfig?.accounts?.length) {
      console.error(
        `Email bot ${runtime.config.name} requires email account config (email_accounts or gmail_email/gmail_password).`,
      );
      return;
    }
    registerEmailHandlers({
      runtime,
      telegramBot: runtime.bot,
      db,
      escapeMarkdown,
    });
    return;
  }

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
    banMediaStorageForChatId,
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
  // Email bot should never receive WhatsApp forwarded messages.
  if (runtime.config.mode === "email") {
    return false;
  }

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
  const ext = getExtensionFromMime(mimeType);
  const filename = `whatsapp-media.${ext}`;
  const fileOptions = {
    filename,
    contentType: mimeType,
  };

  const captionText = caption.replace(/\\/g, "");
  if (mimeType.startsWith("image/")) {
    sentMessage = await runtime.bot.sendPhoto(chatId, mediaBuffer, {
      caption: captionText,
      filename: fileOptions.filename,
      contentType: fileOptions.contentType,
    });
  } else if (mimeType.startsWith("video/")) {
    sentMessage = await runtime.bot.sendVideo(chatId, mediaBuffer, {
      caption: captionText,
      filename: fileOptions.filename,
      contentType: fileOptions.contentType,
    });
  } else if (mimeType.startsWith("audio/")) {
    sentMessage = await runtime.bot.sendAudio(chatId, mediaBuffer, {
      caption: captionText,
      filename: fileOptions.filename,
      contentType: fileOptions.contentType,
    });
  } else {
    sentMessage = await runtime.bot.sendDocument(chatId, mediaBuffer, {
      caption: captionText,
      filename: fileOptions.filename,
      contentType: fileOptions.contentType,
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
        console.error(`Failed to send media to bot ${runtime.config?.name}:`, error);
        await sendToRuntime(
          runtime,
          caption + "\n\n_[Media failed to send: " + (error && error.message ? error.message : "") + "]_",
          whatsappChatId,
        );
      }
    }
  } catch (error) {
    console.error("Media processing failed:", error);
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

    let dbBody = message.body || "";
    let dbType = message.type;

    // Ensure chat row exists before inserting media/files (prevents FK errors)
    insertChat.run(chatId, chatName);

    if (message.hasMedia) {
      const skipStorage = shouldSkipMediaStorage(chatId, chatName);
      dbBody = "[media]";

      if (!skipStorage) {
        try {
          const saved = await saveIncomingMediaToStorage(message, chatId);
          if (saved) {
            dbBody = `[media] ${saved.relativePath}`;
            insertMediaFile.run(
              chatId,
              senderName,
              message.type,
              saved.mimeType,
              saved.relativePath,
              saved.fileSize,
              message.body || "",
              1,
            );
          } else {
            insertMediaFile.run(
              chatId,
              senderName,
              message.type,
              null,
              null,
              null,
              message.body || "",
              0,
            );
          }
        } catch (error) {
          console.error("Failed to save incoming media:", error.message);
          insertMediaFile.run(
            chatId,
            senderName,
            message.type,
            null,
            null,
            null,
            message.body || "",
            0,
          );
        }
      } else {
        insertMediaFile.run(
          chatId,
          senderName,
          message.type,
          null,
          null,
          null,
          message.body || "",
          0,
        );
      }
    }

    insertMessage.run(chatId, senderName, dbBody, dbType);

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
const emailBots = botConfigs.filter((c) => c.mode === "email");
const whatsappBots = botConfigs.filter((c) => c.mode !== "email");

scheduleDailyMediaCleanupAtMidnight();

if (emailBots.length > 0 && whatsappBots.length === 0) {
  console.log("Only email bots found. Skipping WhatsApp initialization.");
} else if (whatsappBots.length === 0) {
  console.log("No WhatsApp bots found.");
}

for (const config of botConfigs) {
  const runtime = createRuntime(config);
  botRuntimes.push(runtime);
  setupBotHandlers(runtime);
}

console.log(`Starting bridge with ${botRuntimes.length} Telegram bot(s)...`);
for (const runtime of botRuntimes) {
  if (runtime.config.mode === "email") {
    console.log(
      `- ${runtime.config.name} [email] (chatId: ${runtime.config.chatId})`,
    );
  } else {
    console.log(
      `- ${runtime.config.name} [${runtime.config.mode}] (chatId: ${runtime.config.chatId})`,
    );
  }
}

if (whatsappBots.length > 0) {
  whatsappClient.initialize();
}
