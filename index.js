import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import qrcode from 'qrcode-terminal';
import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import fs from 'fs';

dotenv.config();

// Find Chrome/Chromium on the system (only needed for ARM Linux)
function findChrome() {
    // On Windows/x86 Linux, let Puppeteer use its bundled Chromium
    const isARM = process.arch === 'arm64' || process.arch === 'arm';
    const isLinux = process.platform === 'linux';
    
    // Only search for system browser on ARM Linux (Puppeteer doesn't have ARM binaries)
    if (!isLinux || !isARM) {
        return undefined;
    }
    
    const paths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        '/usr/lib64/chromium-browser/chromium-browser',
        '/usr/lib/chromium-browser/chromium-browser',
    ];
    
    for (const p of paths) {
        try {
            if (fs.existsSync(p)) {
                console.log(`🌐 Using system browser: ${p}`);
                return p;
            }
        } catch (e) {}
    }
    
    console.log('⚠️ No system browser found. Install chromium: sudo dnf install chromium');
    return undefined;
}

const chromePath = process.env.CHROME_PATH || findChrome();

// Initialize SQLite database
const db = new Database('./messages.db');

// Create tables
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
`);

// Prepared statements for better performance
const insertChat = db.prepare(`
    INSERT OR REPLACE INTO chats (id, name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
`);

const insertMessage = db.prepare(`
    INSERT INTO messages (chat_id, sender_name, body, type) VALUES (?, ?, ?, ?)
`);

const getChats = db.prepare(`
    SELECT c.id, c.name, COUNT(m.id) as message_count 
    FROM chats c 
    LEFT JOIN messages m ON c.id = m.chat_id 
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

const getChatStats = db.prepare(`
    SELECT COUNT(*) as total_messages, COUNT(DISTINCT chat_id) as total_chats FROM messages
`);

// Telegram configuration
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('❌ Error: Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env file');
    console.log('📝 Copy .env.example to .env and fill in your credentials');
    process.exit(1);
}

// Initialize Telegram bot with polling to receive commands
const telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Store last chat for quick replies
let lastWhatsAppChat = null;

// Store mapping of Telegram message ID -> WhatsApp chat ID for reply feature
const messageMap = new Map();

// Initialize WhatsApp client with local authentication (saves session)
const whatsappClient = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        ...(chromePath && { executablePath: chromePath }),
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions'
        ]
    }
});

// Format message for Telegram
function formatMessage(message, contact, chat) {
    const senderName = contact?.pushname || contact?.name || message.from;
    const chatName = chat?.name || 'Private Chat';
    const isGroup = chat?.isGroup;
    const chatId = message.from;
    
    let header = isGroup 
        ? `📱 *WhatsApp Group:* ${escapeMarkdown(chatName)}\n👤 *From:* ${escapeMarkdown(senderName)}`
        : `📱 *WhatsApp from:* ${escapeMarkdown(senderName)}`;
    
    // Add chat ID for replying
    header += `\n🆔 \`${chatId}\``;
    
    return `${header}\n\n${escapeMarkdown(message.body)}`;
}

// Escape special characters for Telegram MarkdownV2
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// Send message to Telegram and store mapping for replies
async function sendToTelegram(text, whatsappChatId = null, options = {}) {
    try {
        const sentMessage = await telegramBot.sendMessage(TELEGRAM_CHAT_ID, text, {
            parse_mode: 'MarkdownV2',
            ...options
        });
        
        // Store mapping for reply feature
        if (whatsappChatId && sentMessage.message_id) {
            messageMap.set(sentMessage.message_id, whatsappChatId);
            // Clean old entries (keep last 1000)
            if (messageMap.size > 1000) {
                const firstKey = messageMap.keys().next().value;
                messageMap.delete(firstKey);
            }
        }
        
        console.log('✅ Message forwarded to Telegram');
        return sentMessage;
    } catch (error) {
        console.error('❌ Error sending to Telegram:', error.message);
        // Try without markdown if it fails
        try {
            const sentMessage = await telegramBot.sendMessage(TELEGRAM_CHAT_ID, text.replace(/\\/g, ''), {});
            if (whatsappChatId && sentMessage.message_id) {
                messageMap.set(sentMessage.message_id, whatsappChatId);
            }
            console.log('✅ Message forwarded to Telegram (plain text)');
            return sentMessage;
        } catch (e) {
            console.error('❌ Failed to send even plain text:', e.message);
            return null;
        }
    }
}

// Send media to Telegram
async function sendMediaToTelegram(message, caption, whatsappChatId = null) {
    try {
        const media = await message.downloadMedia();
        if (!media) {
            await sendToTelegram(caption + '\n\n_\\[Media could not be downloaded\\]_', whatsappChatId);
            return;
        }

        const buffer = Buffer.from(media.data, 'base64');
        const mimeType = media.mimetype;
        let sentMessage = null;

        if (mimeType.startsWith('image/')) {
            sentMessage = await telegramBot.sendPhoto(TELEGRAM_CHAT_ID, buffer, { caption: caption.replace(/\\/g, '') });
        } else if (mimeType.startsWith('video/')) {
            sentMessage = await telegramBot.sendVideo(TELEGRAM_CHAT_ID, buffer, { caption: caption.replace(/\\/g, '') });
        } else if (mimeType.startsWith('audio/')) {
            sentMessage = await telegramBot.sendAudio(TELEGRAM_CHAT_ID, buffer, { caption: caption.replace(/\\/g, '') });
        } else {
            sentMessage = await telegramBot.sendDocument(TELEGRAM_CHAT_ID, buffer, { caption: caption.replace(/\\/g, '') });
        }
        
        // Store mapping for reply feature
        if (whatsappChatId && sentMessage && sentMessage.message_id) {
            messageMap.set(sentMessage.message_id, whatsappChatId);
        }
        
        console.log('✅ Media forwarded to Telegram');
    } catch (error) {
        console.error('❌ Error sending media to Telegram:', error.message);
        await sendToTelegram(caption + '\n\n_\\[Media failed to send\\]_', whatsappChatId);
    }
}

// WhatsApp Events
whatsappClient.on('qr', (qr) => {
    console.log('\n📲 Scan this QR code with WhatsApp to login:\n');
    qrcode.generate(qr, { small: true });
});

whatsappClient.on('loading_screen', (percent, message) => {
    console.log(`⏳ Loading: ${percent}% - ${message}`);
});

whatsappClient.on('authenticated', () => {
    console.log('🔐 WhatsApp authenticated');
});

whatsappClient.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
});

whatsappClient.on('ready', async () => {
    console.log('\n✅ WhatsApp Web is ready!');
    console.log('📨 Messages will now be forwarded to Telegram\n');
    
    // Send startup notification to Telegram
    await sendToTelegram('🟢 *WhatsApp to Telegram Bridge is now active\\!*');
});

whatsappClient.on('disconnected', (reason) => {
    console.log('❌ WhatsApp disconnected:', reason);
});

// Main message handler
whatsappClient.on('message', async (message) => {
    try {
        // Skip status updates and broadcast messages
        if (message.isStatus || message.from === 'status@broadcast') {
            return;
        }

        const contact = await message.getContact();
        const chat = await message.getChat();
        
        // Store last chat for quick replies
        lastWhatsAppChat = message.from;
        
        // Save to SQLite
        const chatId = message.from;
        const chatName = chat?.name || contact?.pushname || contact?.name || chatId;
        const senderName = contact?.pushname || contact?.name || 'Unknown';
        
        insertChat.run(chatId, chatName);
        insertMessage.run(chatId, senderName, message.body || '', message.type);
        
        console.log(`📩 New message from ${senderName}`);

        // Format the caption/header
        const caption = formatMessage(message, contact, chat);

        // Handle different message types
        const whatsappChatId = message.from;
        
        if (message.hasMedia) {
            await sendMediaToTelegram(message, caption, whatsappChatId);
        } else if (message.type === 'chat') {
            await sendToTelegram(caption, whatsappChatId);
        } else if (message.type === 'location') {
            const locationText = caption + `\n\n📍 Location: ${message.location.latitude}, ${message.location.longitude}`;
            await sendToTelegram(locationText, whatsappChatId);
        } else if (message.type === 'vcard' || message.type === 'multi_vcard') {
            await sendToTelegram(caption + '\n\n_\\[Contact card received\\]_', whatsappChatId);
        } else {
            await sendToTelegram(caption + `\n\n_\\[${message.type} message\\]_`, whatsappChatId);
        }

    } catch (error) {
        console.error('❌ Error processing message:', error.message);
    }
});

// Handle group notifications (joins, leaves, etc.)
whatsappClient.on('group_join', async (notification) => {
    const chat = await notification.getChat();
    await sendToTelegram(`👋 Someone joined group: *${escapeMarkdown(chat.name)}*`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await sendToTelegram('🔴 *WhatsApp to Telegram Bridge is shutting down*');
    telegramBot.stopPolling();
    await whatsappClient.destroy();
    process.exit(0);
});

// ==================== TELEGRAM COMMANDS ====================

// /start command - show help
telegramBot.onText(/\/start/, (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const helpText = `
🤖 *WhatsApp ↔ Telegram Bridge*

*Mesaj Gönderme:*
• Mesaja yanıt ver \\→ O kişiye gider
• /send \\<id\\> \\<mesaj\\> \\- Mesaj gönder
• /reply \\<mesaj\\> \\- Son kişiye yanıt

*Geçmiş:*
• /chats \\- Kayıtlı sohbetler
• /messages \\<id\\> \\[sayı\\] \\- Mesaj geçmişi
• /search \\<kelime\\> \\- Mesaj ara

*Örnek:*
\`/messages 905551234567@c.us\`
\`/messages 905551234567@c.us 50\`
\`/search merhaba\`
    `;
    telegramBot.sendMessage(TELEGRAM_CHAT_ID, helpText, { parse_mode: 'MarkdownV2' });
});

// /send command - send message to specific WhatsApp number
telegramBot.onText(/\/send (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const input = match[1];
    const parts = input.split(' ');
    const whatsappId = parts[0];
    const message = parts.slice(1).join(' ');
    
    if (!whatsappId || !message) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, '❌ Kullanım: /send <numara@c.us> <mesaj>');
        return;
    }
    
    try {
        await whatsappClient.sendMessage(whatsappId, message);
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `✅ Mesaj gönderildi: ${whatsappId}`);
        console.log(`📤 Message sent to ${whatsappId}`);
    } catch (error) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `❌ Hata: ${error.message}`);
        console.error('Error sending message:', error);
    }
});

// /reply command - reply to last person who messaged
telegramBot.onText(/\/reply (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const message = match[1];
    
    if (!lastWhatsAppChat) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, '❌ Henüz yanıtlanacak mesaj yok');
        return;
    }
    
    try {
        await whatsappClient.sendMessage(lastWhatsAppChat, message);
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `✅ Yanıt gönderildi: ${lastWhatsAppChat}`);
        console.log(`📤 Reply sent to ${lastWhatsAppChat}`);
    } catch (error) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `❌ Hata: ${error.message}`);
        console.error('Error sending reply:', error);
    }
});

// /chats command - list chats with message counts
telegramBot.onText(/\/chats/, async (msg) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    try {
        const chats = getChats.all();
        const stats = getChatStats.get();
        
        if (chats.length === 0) {
            telegramBot.sendMessage(TELEGRAM_CHAT_ID, '📭 Henüz kayıtlı mesaj yok.');
            return;
        }
        
        let chatList = `📋 *Kayıtlı Sohbetler* \\(${stats.total_messages} mesaj, ${stats.total_chats} sohbet\\)\n\n`;
        
        for (const chat of chats) {
            const name = escapeMarkdown(chat.name || 'Bilinmeyen');
            chatList += `• ${name} \\(${chat.message_count}\\)\n  \`${chat.id}\`\n\n`;
        }
        
        chatList += '_Mesajları görmek için:_\n`/messages <chat\\_id> [sayı]`';
        
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, chatList, { parse_mode: 'MarkdownV2' });
    } catch (error) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `❌ Hata: ${error.message}`);
    }
});

// /messages command - get messages from a specific chat (with optional count)
telegramBot.onText(/\/messages (\S+)\s*(\d*)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const chatId = match[1].trim();
    const count = parseInt(match[2]) || 20; // Default 20, user can specify
    const limitedCount = Math.min(count, 100); // Max 100
    
    const messages = getMessages.all(chatId, limitedCount);
    
    if (messages.length === 0) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, '❌ Bu sohbette kayıtlı mesaj yok.\n/chats ile sohbetleri listeleyin.');
        return;
    }
    
    // Get chat name
    const chatInfo = db.prepare('SELECT name FROM chats WHERE id = ?').get(chatId);
    const name = chatInfo?.name || chatId;
    
    let text = `📱 *${escapeMarkdown(name)}* \\- Son ${messages.length} mesaj:\n\n`;
    
    // Reverse to show oldest first
    for (const m of messages.reverse()) {
        const time = new Date(m.timestamp).toLocaleString('tr-TR', { 
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' 
        });
        const body = escapeMarkdown((m.body || `[${m.type}]`).substring(0, 100));
        text += `\\[${escapeMarkdown(time)}\\] ${body}\n`;
    }
    
    // Split if too long
    if (text.length > 4000) {
        text = text.substring(0, 4000) + '\n\\.\\.\\._\\(kısaltıldı\\)_';
    }
    
    telegramBot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'MarkdownV2' });
});

// /search command - search messages
telegramBot.onText(/\/search (.+)/, async (msg, match) => {
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    const query = match[1].trim();
    const results = searchMessages.all(`%${query}%`);
    
    if (results.length === 0) {
        telegramBot.sendMessage(TELEGRAM_CHAT_ID, `🔍 "${query}" için sonuç bulunamadı.`);
        return;
    }
    
    let text = `🔍 *"${escapeMarkdown(query)}"* için ${results.length} sonuç:\n\n`;
    
    for (const r of results) {
        const time = new Date(r.timestamp).toLocaleString('tr-TR', { 
            day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' 
        });
        text += `*${escapeMarkdown(r.chat_name || 'Bilinmeyen')}*\n`;
        text += `${escapeMarkdown((r.body || '').substring(0, 80))}\n`;
        text += `_${escapeMarkdown(time)}_\n\n`;
    }
    
    if (text.length > 4000) {
        text = text.substring(0, 4000) + '\n\\.\\.\\._\\(kısaltıldı\\)_';
    }
    
    telegramBot.sendMessage(TELEGRAM_CHAT_ID, text, { parse_mode: 'MarkdownV2' });
});

// Handle replies to bot messages - send to WhatsApp
telegramBot.on('message', async (msg) => {
    // Only process from authorized chat
    if (msg.chat.id.toString() !== TELEGRAM_CHAT_ID) return;
    
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;
    
    // Check if this is a reply to a bot message
    if (msg.reply_to_message) {
        const replyToId = msg.reply_to_message.message_id;
        const whatsappChatId = messageMap.get(replyToId);
        
        if (whatsappChatId) {
            try {
                await whatsappClient.sendMessage(whatsappChatId, msg.text);
                console.log(`📤 Reply sent to ${whatsappChatId}`);
                // React with checkmark to confirm
                telegramBot.sendMessage(TELEGRAM_CHAT_ID, '✅', { 
                    reply_to_message_id: msg.message_id 
                });
            } catch (error) {
                telegramBot.sendMessage(TELEGRAM_CHAT_ID, `❌ Gönderilemedi: ${error.message}`);
                console.error('Error sending reply:', error);
            }
        } else {
            telegramBot.sendMessage(TELEGRAM_CHAT_ID, '❌ Bu mesajın WhatsApp kaynağı bulunamadı. /reply veya /send kullanın.');
        }
    }
});

// Start the WhatsApp client
console.log('🚀 Starting WhatsApp to Telegram Bridge...');
console.log('📝 Make sure you have set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env file\n');
whatsappClient.initialize();
