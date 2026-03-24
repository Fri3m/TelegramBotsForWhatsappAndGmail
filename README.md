# Telegram Bots for Whatsapp and Gmail

Run Telegram bots for both WhatsApp and Gmail: forward WhatsApp messages and receive Gmail updates in Telegram from a single project.

## Features

- 📱 Forwards all WhatsApp messages to Telegram
- 🤖 Supports multiple Telegram bots at the same time
- 📧 Supports dedicated email mode bot (single or multiple Gmail accounts)
- 🖼️ Supports images, videos, audio, and documents
- 👥 Works with both private chats and groups
- 📍 Forwards location messages
- 🗂️ Stores incoming WhatsApp media files on disk with metadata in SQLite
- 🚫 Supports per-chat/group media storage exclusions (shows only `[media]`)
- 🧹 Deletes media older than 7 days automatically every day at 00:00
- 💾 Saves WhatsApp session (no need to scan QR every time)

## Setup

### 1. Create Telegram Bots

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the instructions
3. Copy the **Bot Token** you receive
4. Repeat for each bot you want to run

### 2. Get Your Telegram Chat ID

1. Search for `@userinfobot` on Telegram
2. Start a chat with it
3. It will reply with your **Chat ID**

### 3. Configure the App (Multi-Bot)

1. Create one JSON file per bot under `bots/`.
   You can create `general`, `connection`, and `email` mode bots.

   Example: `bots/general.bot.json`

   ```json
   {
     "name": "general-bot",
     "mode": "general",
     "token": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz",
     "chatId": "123456789"
   }
   ```

   Example: `bots/connection.bot.json`

   ```json
   {
     "name": "connection-bot",
     "mode": "connection",
     "token": "987654321:XYZabcDEFghiJKLmnopQRST",
     "chatId": "987654321"
   }
   ```

   Example: `bots/email-bot.json`

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
       }
     ]
   }
   ```

2. `bots/example.*.json` files are templates and are ignored at runtime.

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the App

```bash
npm start
```

### 6. Scan the QR Code

When the app starts, a QR code will appear in the terminal. Scan it with WhatsApp:

1. Open WhatsApp on your phone
2. Go to Settings > Linked Devices
3. Tap "Link a Device"
4. Scan the QR code

## Usage

Once connected, all incoming WhatsApp messages are forwarded to every configured Telegram bot chat.

Command split by bot mode:

- `general` bot: reply, `/send <isim> <mesaj>`, `/reply <mesaj>`, `/chats`, `/messages <isim> [sayi]`, `/search <kelime>`
- `connection` bot: `/connect`, `/disconnect`, `/s` (or direct message after connect)
- `email` bot: `/emails [hesap_adi] [sayi]`, `/email [hesap_adi] [sayi]`, `/search <kelime>`

Notes for email mode:

- Email mode bot does not receive WhatsApp forwards.
- `/emails` returns latest mails; the newest appears at the bottom.
- Auto-check notifies only mails that arrived since the last check.

Detailed email setup: see `EMAIL_SETUP.md`.

Media storage policy:

- Incoming WhatsApp media is saved under `media/YYYY-MM-DD/...`
- Media metadata is stored in `messages.db` table: `media_files`
- To skip media storage for specific chats/groups, create `media-rules.json` in project root

`media-rules.json` example:

```json
{
  "skipMediaStorageChatIds": [
    "905xxxxxxxxx@c.us",
    "1203630xxxxxxxx@g.us"
  ],
  "skipMediaStorageNamePatterns": [
    "aile",
    "is grubu"
  ]
}
```

Template file: `media-rules.example.json`.

Press `Ctrl+C` to stop the app gracefully.

## Notes

- The WhatsApp session is saved in `.wwebjs_auth/` folder
- Delete this folder if you want to log in with a different account
- Keep the app running to receive messages
- Works best on a computer that's always on (or a server)
- Keep private bot config files under `bots/*.json` (already ignored by git)

## Oracle Linux 9 ARM Setup

If Chromium isn't available in default repos:

```bash
# Enable EPEL repository
sudo dnf config-manager --enable ol9_developer_EPEL

# If that doesn't work, try:
sudo dnf install oracle-epel-release-el9 -y

# Install Chromium
sudo dnf install chromium -y

# If chromium still not found, try installing from Fedora EPEL:
sudo dnf install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm -y
sudo dnf install chromium -y
```

The app auto-detects Chromium path on ARM Linux.

## Troubleshooting

**QR code won't scan:**

- Make sure your WhatsApp is up to date
- Try deleting `.wwebjs_auth/` folder and restart

**Messages not forwarding:**

- Check your `bots/*.json` files have correct `token` and `chatId`
- Make sure you've started a chat with your bot first
- Verify your Chat ID is correct

**Email bot account config error:**

- Ensure `mode` is `email`
- Add either `email_accounts` (recommended) or `gmail_email` + `gmail_password`

**Puppeteer errors:**

- On Linux, you may need to install additional dependencies:
  ```bash
  sudo apt-get install -y libgbm-dev
  ```
