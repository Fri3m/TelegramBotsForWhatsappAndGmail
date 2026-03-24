import Imap from "imap";
import { simpleParser } from "mailparser";

export function registerEmailHandlers({
  runtime,
  telegramBot,
  db,
  escapeMarkdown,
}) {
  const authorizedChatId = runtime.config.chatId;
  const emailConfig = runtime.emailConfig;

  if (!emailConfig || !emailConfig.email || !emailConfig.password) {
    console.error("Email config missing in runtime.emailConfig");
    return;
  }

  let imap = null;
  let isConnected = false;
  let lastCheckTime = 0;
  const emailCache = new Map(); // Store fetched emails

  function initImap() {
    imap = new Imap({
      user: emailConfig.email,
      password: emailConfig.password,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: { interval: 10000, forceNoop: true },
    });

    imap.on("error", (err) => {
      console.error("IMAP error:", err);
      isConnected = false;
    });

    imap.on("end", () => {
      isConnected = false;
      console.log("IMAP connection ended");
    });
  }

  async function connectImap() {
    return new Promise((resolve, reject) => {
      if (isConnected) {
        resolve();
        return;
      }

      try {
        initImap();
        imap.openBox("INBOX", false, (err, box) => {
          if (err) {
            reject(err);
          } else {
            isConnected = true;
            console.log(
              `Connected to IMAP. INBOX has ${box.messages} messages`,
            );
            resolve(box);
          }
        });
        imap.openBox("INBOX", false, () => {});
      } catch (error) {
        reject(error);
      }
    });
  }

  async function fetchNewEmails() {
    if (!isConnected) {
      try {
        await connectImap();
      } catch (err) {
        console.error("Failed to connect to IMAP:", err);
        return [];
      }
    }

    return new Promise((resolve) => {
      try {
        // Search for unseen emails since last check
        const seenBefore = Math.floor(lastCheckTime / 1000);
        const searchCriteria = ["UNSEEN"];

        imap.search(searchCriteria, (err, results) => {
          if (err) {
            console.error("Search error:", err);
            resolve([]);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const emails = [];
          const f = imap.fetch(results.slice(-10), { bodies: "" }); // Last 10 new emails

          f.on("message", (msg, seqno) => {
            let email = {
              id: `${Date.now()}_${seqno}`,
              seqno,
              from: "",
              subject: "",
              date: "",
              body: "",
            };

            msg.on("body", (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) {
                  console.error("Parse error:", err);
                  return;
                }

                email.from = parsed.from?.text || "Unknown";
                email.subject = parsed.subject || "(No subject)";
                email.date =
                  parsed.date?.toLocaleString("tr-TR") ||
                  new Date().toLocaleString("tr-TR");
                email.body = (parsed.text || parsed.html || "").substring(
                  0,
                  500,
                );

                emails.push(email);
              });
            });
          });

          f.on("error", (err) => {
            console.error("Fetch error:", err);
          });

          f.on("end", () => {
            lastCheckTime = Date.now();
            resolve(emails);
          });
        });
      } catch (error) {
        console.error("fetchNewEmails error:", error);
        resolve([]);
      }
    });
  }

  async function searchEmails(query) {
    if (!isConnected) {
      try {
        await connectImap();
      } catch (err) {
        console.error("Failed to connect to IMAP:", err);
        return [];
      }
    }

    return new Promise((resolve) => {
      try {
        const searchCriteria = ["ALL", ["TEXT", query]];

        imap.search(searchCriteria, (err, results) => {
          if (err) {
            console.error("Search error:", err);
            resolve([]);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const emails = [];
          const f = imap.fetch(results.slice(-5), { bodies: "" }); // Last 5 matches

          f.on("message", (msg, seqno) => {
            let email = {
              id: `${Date.now()}_${seqno}`,
              seqno,
              from: "",
              subject: "",
              date: "",
              body: "",
            };

            msg.on("body", (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (err) {
                  console.error("Parse error:", err);
                  return;
                }

                email.from = parsed.from?.text || "Unknown";
                email.subject = parsed.subject || "(No subject)";
                email.date =
                  parsed.date?.toLocaleString("tr-TR") ||
                  new Date().toLocaleString("tr-TR");
                email.body = (parsed.text || parsed.html || "").substring(
                  0,
                  500,
                );

                emails.push(email);
              });
            });
          });

          f.on("error", (err) => {
            console.error("Fetch error:", err);
          });

          f.on("end", () => {
            resolve(emails);
          });
        });
      } catch (error) {
        console.error("searchEmails error:", error);
        resolve([]);
      }
    });
  }

  function formatEmailMessage(email) {
    return (
      `*From:* ${escapeMarkdown(email.from)}\n` +
      `*Subject:* ${escapeMarkdown(email.subject)}\n` +
      `*Date:* ${escapeMarkdown(email.date)}\n\n` +
      `${escapeMarkdown(email.body)}`
    );
  }

  function isAuthorized(msg) {
    return msg.chat.id.toString() === authorizedChatId;
  }

  // Commands
  telegramBot.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg)) return;

    const helpText = `
WhatsApp Email Bot (${runtime.config.name})

Email Islemleri:
• /emails - Son mailleri goster
• /search <kelime> - Mail ara
    `;

    telegramBot.sendMessage(authorizedChatId, helpText);
  });

  telegramBot.onText(/\/emails/, async (msg) => {
    if (!isAuthorized(msg)) return;

    try {
      const emails = await fetchNewEmails();

      if (emails.length === 0) {
        telegramBot.sendMessage(authorizedChatId, "Yeni mail yok\\.", {
          parse_mode: "MarkdownV2",
        });
        return;
      }

      let text = `*${emails.length} yeni mail:*\n\n`;

      for (const email of emails) {
        text += `${formatEmailMessage(email)}\n\n___\n\n`;
      }

      if (text.length > 4000) {
        text = text.substring(0, 4000) + "\n\n\\(kisaltildi\\)";
      }

      telegramBot.sendMessage(authorizedChatId, text, {
        parse_mode: "MarkdownV2",
      });
    } catch (error) {
      telegramBot.sendMessage(
        authorizedChatId,
        `Hata: ${escapeMarkdown(error.message)}`,
        { parse_mode: "MarkdownV2" },
      );
    }
  });

  telegramBot.onText(/\/search (.+)/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    const query = (match[1] || "").trim();

    if (!query) {
      telegramBot.sendMessage(authorizedChatId, "Kullanim: /search <kelime>");
      return;
    }

    try {
      const results = await searchEmails(query);

      if (results.length === 0) {
        telegramBot.sendMessage(
          authorizedChatId,
          `\\\"${escapeMarkdown(query)}\\\" icin mail bulunamadi\\.`,
          { parse_mode: "MarkdownV2" },
        );
        return;
      }

      let text = `*\\\"${escapeMarkdown(query)}\\\" icin ${results.length} mail:*\n\n`;

      for (const email of results) {
        text += `${formatEmailMessage(email)}\n\n___\n\n`;
      }

      if (text.length > 4000) {
        text = text.substring(0, 4000) + "\n\n\\(kisaltildi\\)";
      }

      telegramBot.sendMessage(authorizedChatId, text, {
        parse_mode: "MarkdownV2",
      });
    } catch (error) {
      telegramBot.sendMessage(
        authorizedChatId,
        `Hata: ${escapeMarkdown(error.message)}`,
        { parse_mode: "MarkdownV2" },
      );
    }
  });

  // Auto-check for new emails every 5 minutes
  setInterval(
    async () => {
      if (!isConnected) return;

      try {
        const emails = await fetchNewEmails();

        if (emails.length > 0) {
          let text = `*${emails.length} yeni mail geldi:*\n\n`;

          for (const email of emails) {
            text += `${formatEmailMessage(email)}\n\n___\n\n`;
          }

          if (text.length > 4000) {
            text = text.substring(0, 4000) + "\n\n\\(kisaltildi\\)";
          }

          telegramBot.sendMessage(authorizedChatId, text, {
            parse_mode: "MarkdownV2",
          });
        }
      } catch (error) {
        console.error("Auto-check error:", error);
      }
    },
    5 * 60 * 1000,
  ); // 5 minutes

  // Initial connect
  connectImap().catch((err) => {
    console.error("Initial IMAP connect failed:", err);
  });
}
