export function registerGeneralHandlers({
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
}) {
  const telegramBot = runtime.bot;
  const authorizedChatId = runtime.config.chatId;

  const getStoredChatTargets = db.prepare(`
    SELECT id, name
    FROM chats
    ORDER BY updated_at DESC
    LIMIT 1000
  `);

  function normalizeText(value) {
    return (value || "").trim().toLocaleLowerCase("tr-TR");
  }

  function scoreTargetMatch(query, target) {
    const q = normalizeText(query);
    const id = normalizeText(target.id);
    const name = normalizeText(target.name);

    if (!q) return 0;
    if (q === id) return 100;
    if (name && q === name) return 95;
    if (name && name.startsWith(q)) return 80;
    if (name && name.includes(q)) return 65;
    return 0;
  }

  async function getKnownTargets() {
    const fromDb = getStoredChatTargets.all().map((row) => ({
      id: row.id,
      name: row.name || row.id,
    }));

    const fromWhatsApp = (await whatsappClient.getChats()).map((chat) => ({
      id: chat.id?._serialized,
      name: chat.name || chat.id?._serialized,
    }));

    const merged = new Map();
    for (const item of [...fromDb, ...fromWhatsApp]) {
      if (!item.id) continue;
      if (!merged.has(item.id)) {
        merged.set(item.id, item);
      }
    }

    return Array.from(merged.values());
  }

  async function resolveTargetByNameOrId(rawTarget) {
    const targetInput = (rawTarget || "").trim();
    if (!targetInput) {
      return null;
    }

    const allTargets = await getKnownTargets();
    let best = null;
    let bestScore = 0;

    for (const target of allTargets) {
      const score = scoreTargetMatch(targetInput, target);
      if (score > bestScore) {
        bestScore = score;
        best = target;
      }
    }

    return bestScore > 0 ? best : null;
  }

  async function parseSendInput(input) {
    const raw = (input || "").trim();
    if (!raw) {
      return null;
    }

    const quotedMatch = raw.match(/^"([^"]+)"\s+(.+)$/);
    if (quotedMatch) {
      const target = await resolveTargetByNameOrId(quotedMatch[1]);
      if (!target) return null;
      return {
        target,
        message: quotedMatch[2].trim(),
      };
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    // Try longest name candidate first so multi-word names work without quotes.
    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const targetCandidate = parts.slice(0, i).join(" ");
      const messageCandidate = parts.slice(i).join(" ").trim();
      if (!messageCandidate) continue;

      const target = await resolveTargetByNameOrId(targetCandidate);
      if (target) {
        return {
          target,
          message: messageCandidate,
        };
      }
    }

    return null;
  }

  async function resolveMessagesInput(rawInput) {
    const raw = (rawInput || "").trim();
    if (!raw) {
      return null;
    }

    let count = 20;
    let targetRaw = raw;

    const trailingCount = raw.match(/^(.*)\s+(\d{1,3})$/);
    if (trailingCount) {
      const candidateTarget = trailingCount[1].trim();
      const candidateCount = parseInt(trailingCount[2], 10);
      const candidateResolved = await resolveTargetByNameOrId(candidateTarget);

      if (candidateResolved) {
        return {
          target: candidateResolved,
          count: Math.min(candidateCount, 100),
        };
      }

      targetRaw = raw;
      count = 20;
    }

    const target = await resolveTargetByNameOrId(targetRaw);
    if (!target) {
      return null;
    }

    return {
      target,
      count,
    };
  }

  function isAuthorized(msg) {
    return msg.chat.id.toString() === authorizedChatId;
  }

  telegramBot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;

    const helpText = `
*WhatsApp General Bot (${escapeMarkdown(runtime.config.name)})*

*Mesaj Gonderme:*
• Mesaja yanit ver -> O kisiye gider
• /send <isim> <mesaj> - Mesaj gonder
• /reply <mesaj> - Son kisiye yanit

*Gecmis:*
• /chats - Kayitli sohbetler
• /messages <isim> [sayi] - Mesaj gecmisi
• /search <kelime> - Mesaj ara
\n_Not: Isimde bosluk varsa tirnak kullanabilirsin. Ornek: /send "Ali Veli" merhaba_
    `;

    telegramBot.sendMessage(authorizedChatId, helpText, {
      parse_mode: "MarkdownV2",
    });
  });

  telegramBot.onText(/\/send (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const parsed = await parseSendInput(match[1]);

    if (!parsed) {
      telegramBot.sendMessage(
        authorizedChatId,
        'Kullanim: /send <isim> <mesaj> veya /send "isim soyisim" <mesaj>',
      );
      return;
    }

    const whatsappId = parsed.target.id;
    const message = parsed.message;

    try {
      await whatsappClient.sendMessage(whatsappId, message);
      await recordOutgoingMessage(
        whatsappId,
        message,
        `Telegram (${runtime.config.name})`,
      );
      telegramBot.sendMessage(
        authorizedChatId,
        `Mesaj gonderildi: ${parsed.target.name}`,
      );
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });

  telegramBot.onText(/\/reply (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const message = match[1];

    if (!runtime.lastWhatsAppChat) {
      telegramBot.sendMessage(authorizedChatId, "Henuz yanitlanacak mesaj yok");
      return;
    }

    try {
      await whatsappClient.sendMessage(runtime.lastWhatsAppChat, message);
      await recordOutgoingMessage(
        runtime.lastWhatsAppChat,
        message,
        `Telegram (${runtime.config.name})`,
      );
      telegramBot.sendMessage(
        authorizedChatId,
        `Yanit gonderildi: ${runtime.lastWhatsAppChat}`,
      );
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });

  telegramBot.onText(/\/chats/, async (msg) => {
    if (!isAuthorized(msg)) return;

    try {
      const chats = getChats.all();
      const stats = getChatStats.get();

      if (chats.length === 0) {
        telegramBot.sendMessage(authorizedChatId, "Henuz kayitli mesaj yok.");
        return;
      }

      let chatList = `Kayitli Sohbetler (${stats.total_messages} mesaj, ${stats.total_chats} sohbet)\n\n`;

      for (const chat of chats) {
        const name = escapeMarkdown(chat.name || "Bilinmeyen");
        const newIncomingCount = Number(chat.new_incoming_count || 0);
        chatList += `• ${name} \(toplam: ${chat.message_count}, yeni: ${newIncomingCount}\)\n  \`${chat.id}\`\n\n`;
      }

      chatList += "Mesajlari gormek icin:\n/messages <isim> [sayi]";

      telegramBot.sendMessage(authorizedChatId, chatList, {
        parse_mode: "MarkdownV2",
      });
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    } finally {
      // /chats was used: reset new incoming counters for all chats.
      resetAllChatStates.run();
    }
  });

  telegramBot.onText(/\/messages (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const parsed = await resolveMessagesInput(match[1]);
    if (!parsed) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Sohbet bulunamadi. /messages <isim> [sayi] seklinde deneyin.",
      );
      return;
    }

    const chatId = parsed.target.id;
    const limitedCount = parsed.count;

    const messages = getMessages.all(chatId, limitedCount);

    if (messages.length === 0) {
      telegramBot.sendMessage(
        authorizedChatId,
        "Bu sohbette kayitli mesaj yok. /chats ile sohbetleri listeleyin.",
      );
      return;
    }

    const name = parsed.target.name || chatId;

    let text = `${escapeMarkdown(name)} - Son ${messages.length} mesaj:\n\n`;

    for (const m of messages.reverse()) {
      const time = new Date(m.timestamp).toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      const sender = escapeMarkdown(m.sender_name || "Bilinmeyen");
      const body = escapeMarkdown((m.body || `[${m.type}]`).substring(0, 100));
      text += `[${escapeMarkdown(time)}] [${sender}] ${body}\n`;
    }

    if (text.length > 4000) {
      text = text.substring(0, 4000) + "\n...(kisaltildi)";
    }

    telegramBot.sendMessage(authorizedChatId, text, {
      parse_mode: "MarkdownV2",
    });

    // /messages was used for this chat: reset new incoming counter.
    resetChatState.run(chatId);
  });

  telegramBot.onText(/\/search (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const query = match[1].trim();
    const results = searchMessages.all(`%${query}%`);

    if (results.length === 0) {
      telegramBot.sendMessage(
        authorizedChatId,
        `\"${query}\" icin sonuc bulunamadi.`,
      );
      return;
    }

    let text = `\"${escapeMarkdown(query)}\" icin ${results.length} sonuc:\n\n`;

    for (const r of results) {
      const time = new Date(r.timestamp).toLocaleString("tr-TR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      text += `*${escapeMarkdown(r.chat_name || "Bilinmeyen")}*\n`;
      text += `${escapeMarkdown((r.body || "").substring(0, 80))}\n`;
      text += `_${escapeMarkdown(time)}_\n\n`;
    }

    if (text.length > 4000) {
      text = text.substring(0, 4000) + "\n...(kisaltildi)";
    }

    telegramBot.sendMessage(authorizedChatId, text, {
      parse_mode: "MarkdownV2",
    });
  });

  telegramBot.on("message", async (msg) => {
    if (!isAuthorized(msg)) return;

    if (msg.text && msg.text.startsWith("/")) return;

    if (msg.reply_to_message) {
      const replyToId = msg.reply_to_message.message_id;
      const whatsappChatId = runtime.messageMap.get(replyToId);

      if (whatsappChatId) {
        try {
          await whatsappClient.sendMessage(whatsappChatId, msg.text || "");
          await recordOutgoingMessage(
            whatsappChatId,
            msg.text || "",
            `Telegram (${runtime.config.name})`,
          );
          telegramBot.sendMessage(authorizedChatId, "OK", {
            reply_to_message_id: msg.message_id,
          });
        } catch (error) {
          telegramBot.sendMessage(
            authorizedChatId,
            `Gonderilemedi: ${error.message}`,
          );
        }
      } else {
        telegramBot.sendMessage(
          authorizedChatId,
          "Bu mesajin WhatsApp kaynagi bulunamadi. /reply veya /send kullanin.",
        );
      }
    }
  });
}
