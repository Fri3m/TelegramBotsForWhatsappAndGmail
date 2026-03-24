import pkg from "whatsapp-web.js";

const { MessageMedia } = pkg;

export function registerConnectionHandlers({
  runtime,
  whatsappClient,
  resolveChatConnection,
  escapeMarkdown,
  recordOutgoingMessage,
}) {
  const telegramBot = runtime.bot;
  const authorizedChatId = runtime.config.chatId;

  function isAuthorized(msg) {
    return msg.chat.id.toString() === authorizedChatId;
  }

  async function buildWhatsAppPayloadFromTelegram(msg) {
    if (msg.photo?.length) {
      const bestPhoto = msg.photo[msg.photo.length - 1];
      const fileLink = await telegramBot.getFileLink(bestPhoto.file_id);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return {
        payload: new MessageMedia("image/jpeg", base64, "telegram-photo.jpg"),
        options: msg.caption ? { caption: msg.caption } : {},
        recordText: msg.caption || "[photo]",
      };
    }

    if (msg.document?.file_id) {
      const fileLink = await telegramBot.getFileLink(msg.document.file_id);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return {
        payload: new MessageMedia(
          msg.document.mime_type || "application/octet-stream",
          base64,
          msg.document.file_name || "telegram-document",
        ),
        options: msg.caption ? { caption: msg.caption } : {},
        recordText: msg.caption || `[document] ${msg.document.file_name || "file"}`,
      };
    }

    if (msg.video?.file_id) {
      const fileLink = await telegramBot.getFileLink(msg.video.file_id);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return {
        payload: new MessageMedia("video/mp4", base64, "telegram-video.mp4"),
        options: msg.caption ? { caption: msg.caption } : {},
        recordText: msg.caption || "[video]",
      };
    }

    if (msg.audio?.file_id || msg.voice?.file_id) {
      const mediaFileId = msg.audio?.file_id || msg.voice?.file_id;
      const fileLink = await telegramBot.getFileLink(mediaFileId);
      const response = await fetch(fileLink);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString("base64");

      return {
        payload: new MessageMedia("audio/ogg", base64, "telegram-audio.ogg"),
        options: msg.caption ? { caption: msg.caption } : {},
        recordText: msg.caption || "[audio]",
      };
    }

    const text = (msg.text || "").trim();
    return {
      payload: text,
      options: {},
      recordText: text,
    };
  }

  telegramBot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;

    const helpText = `
WhatsApp Connection Bot (${runtime.config.name})

Devamli Mesaj:
• /connect [group|person] <isim> - Bir kisi veya gruba baglan
• /disconnect - Connectiondan cik
• /s <mesaj> - Connectiona mesaj gonder
    `;

    telegramBot.sendMessage(authorizedChatId, helpText);
  });

  telegramBot.onText(/\/connect(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const rawInput = (match?.[1] || "").trim();
    if (!rawInput) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Kullanim: /connect <group|person> <isim> veya /connect <isim>",
      );
      return;
    }

    const tokens = rawInput.split(/\s+/).filter(Boolean);
    const firstToken = (tokens[0] || "").toLowerCase();
    const typeAliases = {
      group: "group",
      person: "person",
      kisi: "person",
      grup: "group",
    };

    const targetType = typeAliases[firstToken] || "person";
    const name = typeAliases[firstToken]
      ? tokens.slice(1).join(" ").trim()
      : rawInput;

    if (!name) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Baglanmak icin bir isim yazmaliyim\\. Ornek: /connect group Aile",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    try {
      if (runtime.activeConnection) {
        const previousName =
          runtime.activeConnection.name || runtime.activeConnection.id;
        runtime.activeConnection = null;
        await telegramBot.sendMessage(
          authorizedChatId,
          `Onceki baglanti kapatildi: ${escapeMarkdown(previousName)}`,
          { parse_mode: "MarkdownV2" },
        );
      }

      const chat = await resolveChatConnection(targetType, name);

      if (!chat) {
        telegramBot.sendMessage(
          authorizedChatId,
          `${escapeMarkdown(targetType)} icin eslesen sohbet bulunamadi: ${escapeMarkdown(name)}`,
          { parse_mode: "MarkdownV2" },
        );
        return;
      }

      const chatId = chat.id?._serialized;
      const chatName = chat.name || chatId;

      runtime.activeConnection = {
        id: chatId,
        name: chatName,
        type: chat.isGroup ? "group" : "person",
      };

      telegramBot.sendMessage(
        authorizedChatId,
        `Baglandi: ${escapeMarkdown(chatName)} \\(${escapeMarkdown(runtime.activeConnection.type)}\\)\nID: \`${chatId}\``,
        { parse_mode: "MarkdownV2" },
      );
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });

  telegramBot.onText(/\/disconnect$/, async (msg) => {
    if (!isAuthorized(msg)) return;

    if (!runtime.activeConnection) {
      telegramBot.sendMessage(authorizedChatId, "Aktif baglanti zaten yok.");
      return;
    }

    const previousName =
      runtime.activeConnection.name || runtime.activeConnection.id;
    runtime.activeConnection = null;
    telegramBot.sendMessage(
      authorizedChatId,
      `Baglanti kapatildi: ${escapeMarkdown(previousName)}`,
      { parse_mode: "MarkdownV2" },
    );
  });

  telegramBot.onText(/\/s (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const text = (match?.[1] || "").trim();
    if (!text) {
      telegramBot.sendMessage(authorizedChatId, "Kullanim: /s <mesaj>");
      return;
    }

    if (!runtime.activeConnection) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Aktif baglanti yok. Once /connect ile baglan.",
      );
      return;
    }

    try {
      await whatsappClient.sendMessage(runtime.activeConnection.id, text);
      await recordOutgoingMessage(
        runtime.activeConnection.id,
        text,
        `Telegram (${runtime.config.name})`,
      );
      telegramBot.sendMessage(
        authorizedChatId,
        `Gonderildi: ${escapeMarkdown(runtime.activeConnection.name)}`,
        { parse_mode: "MarkdownV2" },
      );
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });

  // Direct message handler: send all messages to active connection
  telegramBot.on("message", async (msg) => {
    if (!isAuthorized(msg)) return;

    // Skip commands and service messages
    if (msg.text && msg.text.startsWith("/")) return;
    if (msg.successful_payment || msg.new_chat_participant) return;

    if (!runtime.activeConnection) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Aktif baglanti yok\\. Mesaj gonderilemedi\\. Once /connect ile baglan\\.",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    try {
      const outgoing = await buildWhatsAppPayloadFromTelegram(msg);
      if (!outgoing.recordText) {
        telegramBot.sendMessage(
          authorizedChatId,
          "Gonderilecek metin veya medya bulunamadi.",
        );
        return;
      }

      await whatsappClient.sendMessage(
        runtime.activeConnection.id,
        outgoing.payload,
        outgoing.options,
      );
      await recordOutgoingMessage(
        runtime.activeConnection.id,
        outgoing.recordText,
        `Telegram (${runtime.config.name})`,
      );
    } catch (error) {
      telegramBot.sendMessage(
        authorizedChatId,
        `Gonderilemedi: ${escapeMarkdown(error.message)}`,
        { parse_mode: "MarkdownV2" },
      );
    }
  });
}
