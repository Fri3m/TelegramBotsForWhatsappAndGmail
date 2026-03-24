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
        "Baglanmak icin bir isim yazmaliyim. Ornek: /connect group Aile",
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
          `Onceki baglanti kapatildi: ${previousName}`,
        );
      }

      const chat = await resolveChatConnection(targetType, name);

      if (!chat) {
        telegramBot.sendMessage(
          authorizedChatId,
          `${targetType} icin eslesen sohbet bulunamadi: ${name}`,
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
        `Baglandi: ${chatName} (${runtime.activeConnection.type})\nID: ${chatId}`,
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
      `Baglanti kapatildi: ${previousName}`,
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
        `Gonderildi: ${runtime.activeConnection.name}`,
      );
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });
}
