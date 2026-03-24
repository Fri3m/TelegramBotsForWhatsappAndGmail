# Bot Config Files

Create one JSON file per Telegram bot in this folder.

General bot example:

```json
{
  "name": "sales-bot",
  "mode": "general",
  "token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
  "chatId": "123456789"
}
```

Connection bot example:

```json
{
  "name": "connection-bot",
  "mode": "connection",
  "token": "987654321:XYZabcDEFghiJKLmnopQRST",
  "chatId": "987654321"
}
```

Notes:

- `name`: Friendly label for logs.
- `mode`: `general` or `connection`.
- `token`: Bot token from @BotFather.
- `chatId`: Telegram chat ID to receive forwarded messages.
- Any `*.json` file in this folder is loaded (except `example.bot.json`).

Mode command split:

- `general`: reply, /send, /reply, /chats, /messages, /search
- `connection`: /connect, /disconnect, /s
