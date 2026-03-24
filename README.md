# WhatsApp to Telegram Bridge

Forward your WhatsApp messages to one or more Telegram bots automatically.

## Features

- 📱 Forwards all WhatsApp messages to Telegram
- 🤖 Supports multiple Telegram bots at the same time
- 🖼️ Supports images, videos, audio, and documents
- 👥 Works with both private chats and groups
- 📍 Forwards location messages
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
   For your use case, create two files: one `general`, one `connection`.

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

2. `bots/example.bot.json` is only a template and is ignored at runtime.

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
- `connection` bot: `/connect`, `/disconnect`, `/s`

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

**Puppeteer errors:**

- On Linux, you may need to install additional dependencies:
  ```bash
  sudo apt-get install -y libgbm-dev
  ```
