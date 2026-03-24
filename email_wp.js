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
  const emailAccounts = Array.isArray(emailConfig?.accounts)
    ? emailConfig.accounts.filter((a) => a.email && a.password)
    : [];

  if (emailAccounts.length === 0) {
    console.error("Email config missing in runtime.emailConfig");
    return;
  }

  const accountStates = emailAccounts.map((account) => ({
    account,
    imap: null,
    isConnected: false,
    isConnecting: false,
    connectPromise: null,
    lastAutoCheckAt: Date.now(),
  }));

  function initImap(state) {
    state.imap = new Imap({
      user: state.account.email,
      password: state.account.password,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      keepalive: { interval: 10000, forceNoop: true },
    });

    state.imap.on("error", (err) => {
      console.error(`IMAP error (${state.account.email}):`, err);
      state.isConnected = false;
      state.isConnecting = false;
    });

    state.imap.on("end", () => {
      state.isConnected = false;
      state.isConnecting = false;
      state.imap = null;
      console.log(`IMAP connection ended (${state.account.email})`);
    });
  }

  async function connectImap(state) {
    if (state.isConnected) {
      return;
    }

    if (state.connectPromise) {
      return state.connectPromise;
    }

    state.connectPromise = new Promise((resolve, reject) => {
      try {
        initImap(state);
        state.isConnecting = true;

        state.imap.once("ready", () => {
          state.imap.openBox("INBOX", false, (err, box) => {
            if (err) {
              state.isConnecting = false;
              state.connectPromise = null;
              reject(err);
              return;
            }

            state.isConnected = true;
            state.isConnecting = false;
            state.connectPromise = null;
            const totalMessages = box?.messages?.total ?? box?.messages ?? 0;
            console.log(
              `Connected to IMAP (${state.account.email}). INBOX has ${totalMessages} messages`,
            );
            resolve(box);
          });
        });

        state.imap.once("error", (err) => {
          state.isConnecting = false;
          state.connectPromise = null;
          reject(err);
        });

        state.imap.connect();
      } catch (error) {
        state.isConnecting = false;
        state.connectPromise = null;
        reject(error);
      }
    });

    return state.connectPromise;
  }

  function fetchEmailsByCriteria(state, searchCriteria, limit = 10) {
    return new Promise((resolve) => {
      try {
        if (!state.imap) {
          resolve([]);
          return;
        }

        state.imap.search(searchCriteria, (err, results) => {
          if (err) {
            console.error(`Search error (${state.account.email}):`, err);
            if (/Not authenticated/i.test(err.message || "")) {
              state.isConnected = false;
            }
            resolve([]);
            return;
          }

          if (!results || results.length === 0) {
            resolve([]);
            return;
          }

          const emails = [];
          const fetchIds = results.slice(-Math.max(1, limit));
          const f = state.imap.fetch(fetchIds, { bodies: "" });
          const parseJobs = [];

          f.on("message", (msg, seqno) => {
            const parseJob = new Promise((resolveMessage) => {
              msg.on("body", async (stream) => {
                try {
                  const parsed = await simpleParser(stream);
                  resolveMessage({
                    id: `${Date.now()}_${seqno}`,
                    seqno,
                    accountEmail: state.account.email,
                    accountName: state.account.name || state.account.email,
                    from: parsed.from?.text || "Unknown",
                    subject: parsed.subject || "(No subject)",
                    timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                    date:
                      parsed.date?.toLocaleString("tr-TR") ||
                      new Date().toLocaleString("tr-TR"),
                    body: (parsed.text || parsed.html || "").substring(0, 500),
                  });
                } catch (err) {
                  console.error("Parse error:", err);
                  resolveMessage(null);
                }
              });

              msg.once("error", () => {
                resolveMessage(null);
              });
            });

            parseJobs.push(parseJob);
          });

          f.on("error", (err) => {
            console.error(`Fetch error (${state.account.email}):`, err);
            if (/Not authenticated/i.test(err.message || "")) {
              state.isConnected = false;
            }
          });

          f.on("end", async () => {
            try {
              const parsedEmails = await Promise.all(parseJobs);
              for (const item of parsedEmails) {
                if (item) {
                  emails.push(item);
                }
              }
              emails.sort((a, b) => b.timestamp - a.timestamp);
              resolve(emails);
            } catch (err) {
              console.error("Email parse aggregation error:", err);
              resolve(emails);
            }
          });
        });
      } catch (error) {
        console.error("fetchEmailsByCriteria error:", error);
        resolve([]);
      }
    });
  }

  async function fetchLatestEmails(limit = 10) {
    return fetchLatestEmailsFromStates(accountStates, limit);
  }

  async function fetchLatestEmailsFromStates(states, limit = 10) {
    if (!states || states.length === 0) {
      return [];
    }

    const normalizedLimit = Math.min(Math.max(Number(limit) || 10, 1), 50);
    const perAccountFetch = Math.max(normalizedLimit, 10);

    const accountResults = await Promise.all(
      states.map(async (state) => {
        try {
          await connectImap(state);
          return fetchEmailsByCriteria(state, ["ALL"], perAccountFetch);
        } catch (err) {
          console.error(
            `Failed to connect to IMAP (${state.account.email}):`,
            err,
          );
          return [];
        }
      }),
    );

    const merged = accountResults
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp);
    return merged.slice(0, normalizedLimit);
  }

  function findAccountStatesByName(query) {
    const q = String(query || "")
      .trim()
      .toLocaleLowerCase("tr-TR");
    if (!q) {
      return [];
    }

    const matches = accountStates.filter((state) => {
      const accountName = String(state.account.name || "").toLocaleLowerCase(
        "tr-TR",
      );
      const accountEmail = String(state.account.email || "").toLocaleLowerCase(
        "tr-TR",
      );

      return (
        accountName === q ||
        accountEmail === q ||
        accountName.includes(q) ||
        accountEmail.includes(q)
      );
    });

    return matches;
  }

  function parseEmailsArgs(rawInput) {
    const raw = String(rawInput || "").trim();
    if (!raw) {
      return { limit: 10, accountQuery: null };
    }

    const parts = raw.split(/\s+/).filter(Boolean);
    let limit = 10;
    let accountQuery = null;

    if (parts.length === 1) {
      if (/^\d{1,3}$/.test(parts[0])) {
        limit = Math.min(Math.max(parseInt(parts[0], 10), 1), 50);
      } else {
        accountQuery = parts[0];
      }
      return { limit, accountQuery };
    }

    const firstIsNum = /^\d{1,3}$/.test(parts[0]);
    const lastIsNum = /^\d{1,3}$/.test(parts[parts.length - 1]);

    if (firstIsNum) {
      limit = Math.min(Math.max(parseInt(parts[0], 10), 1), 50);
      accountQuery = parts.slice(1).join(" ").trim() || null;
      return { limit, accountQuery };
    }

    if (lastIsNum) {
      limit = Math.min(Math.max(parseInt(parts[parts.length - 1], 10), 1), 50);
      accountQuery = parts.slice(0, -1).join(" ").trim() || null;
      return { limit, accountQuery };
    }

    accountQuery = raw;
    return { limit, accountQuery };
  }

  async function fetchEmailsSince(state, sinceTs, fetchWindow = 50) {
    try {
      await connectImap(state);
    } catch (err) {
      console.error(`Failed to connect to IMAP (${state.account.email}):`, err);
      return [];
    }

    const latest = await fetchEmailsByCriteria(
      state,
      ["ALL"],
      Math.min(Math.max(fetchWindow, 10), 200),
    );

    return latest
      .filter((email) => email.timestamp > sinceTs)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async function searchEmails(query) {
    const accountResults = await Promise.all(
      accountStates.map(async (state) => {
        try {
          await connectImap(state);
          return fetchEmailsByCriteria(state, ["ALL", ["TEXT", query]], 5);
        } catch (err) {
          console.error(
            `Failed to connect to IMAP (${state.account.email}):`,
            err,
          );
          return [];
        }
      }),
    );

    return accountResults
      .flat()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 20);
  }

  function formatEmailMessage(email) {
    return (
      `Account: ${email.accountName}\n` +
      `From: ${email.from}\n` +
      `Subject: ${email.subject}\n` +
      `Date: ${email.date}\n\n` +
      `${email.body}`
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
• /emails [hesap_adi] [sayi] - Son mailleri goster
• /email [hesap_adi] [sayi] - /emails ile ayni
• /search <kelime> - Mail ara
    `;

    telegramBot.sendMessage(authorizedChatId, helpText);
  });

  telegramBot.onText(/\/emails?(?:\s+(.+))?$/, async (msg, match) => {
    if (!isAuthorized(msg)) return;

    try {
      const parsed = parseEmailsArgs(match?.[1] || "");

      let targetStates = accountStates;
      if (parsed.accountQuery) {
        targetStates = findAccountStatesByName(parsed.accountQuery);
        if (targetStates.length === 0) {
          telegramBot.sendMessage(
            authorizedChatId,
            `Hesap bulunamadi: ${parsed.accountQuery}`,
          );
          return;
        }
      }

      const emails = await fetchLatestEmailsFromStates(
        targetStates,
        parsed.limit,
      );

      if (emails.length === 0) {
        telegramBot.sendMessage(authorizedChatId, "Mail bulunamadi.");
        return;
      }

      const orderedEmails = [...emails].reverse();
      const scopeLabel = parsed.accountQuery
        ? `${parsed.accountQuery} icin `
        : "";
      let text = `${scopeLabel}Son ${orderedEmails.length} mail (eskiden yeniye):\n\n`;

      for (const email of orderedEmails) {
        text += `${formatEmailMessage(email)}\n\n--------------------\n\n`;
      }

      if (text.length > 4000) {
        text = text.substring(0, 4000) + "\n\n(kisaltildi)";
      }

      telegramBot.sendMessage(authorizedChatId, text);
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
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
          `"${query}" icin mail bulunamadi.`,
        );
        return;
      }

      let text = `"${query}" icin ${results.length} mail:\n\n`;

      for (const email of results) {
        text += `${formatEmailMessage(email)}\n\n--------------------\n\n`;
      }

      if (text.length > 4000) {
        text = text.substring(0, 4000) + "\n\n(kisaltildi)";
      }

      telegramBot.sendMessage(authorizedChatId, text);
    } catch (error) {
      telegramBot.sendMessage(authorizedChatId, `Hata: ${error.message}`);
    }
  });

  // Auto-check for new emails every 5 minutes
  setInterval(
    async () => {
      try {
        const now = Date.now();
        const results = await Promise.all(
          accountStates.map(async (state) => {
            const emails = await fetchEmailsSince(
              state,
              state.lastAutoCheckAt,
              100,
            );
            state.lastAutoCheckAt = now;
            return emails;
          }),
        );
        const emails = results.flat().sort((a, b) => a.timestamp - b.timestamp);

        if (emails.length > 0) {
          let text = `${emails.length} yeni mail geldi:\n\n`;

          for (const email of emails) {
            text += `${formatEmailMessage(email)}\n\n--------------------\n\n`;
          }

          if (text.length > 4000) {
            text = text.substring(0, 4000) + "\n\n(kisaltildi)";
          }

          telegramBot.sendMessage(authorizedChatId, text);
        }
      } catch (error) {
        console.error("Auto-check error:", error);
      }
    },
    5 * 60 * 1000,
  ); // 5 minutes

  // Initial connect
  Promise.all(
    accountStates.map(async (state) => {
      try {
        await connectImap(state);
        state.lastAutoCheckAt = Date.now();
      } catch (err) {
        console.error(
          `Initial IMAP connect failed (${state.account.email}):`,
          err,
        );
      }
    }),
  );
}
