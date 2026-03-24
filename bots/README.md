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

Email bot example:

```json
{
  "name": "email-bot",
  "mode": "email",
  "token": "111222333:EMAILTOKEN",
  "chatId": "123456789",
  "email_accounts": [
    {
      "name": "email1",
      "email": "your-email@gmail.com",
      "password": "gmail-app-password"
    },
    {
      "name": "email2",
      "email": "your-second@gmail.com",
      "password": "gmail-app-password-2"
    }
  ]
}
```

Notes:

- `name`: Friendly label for logs.
- `mode`: `general`, `connection`, or `email`.
- `token`: Bot token from @BotFather.
- `chatId`: Telegram chat ID to receive forwarded messages.
- For email mode, set `email_accounts` (recommended) or `gmail_email` + `gmail_password`.
- Any `*.json` file in this folder is loaded except `example.*.json` templates.

Mode command split:

- `general`: reply, /send, /reply, /chats, /messages, /search
- `connection`: /connect, /disconnect, /s
- `email`: /emails [hesap_adi] [sayi], /email [hesap_adi] [sayi], /search
