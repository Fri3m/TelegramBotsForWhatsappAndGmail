# WhatsApp to Telegram Bridge

Forward your WhatsApp messages to Telegram automatically.

## Features

- 📱 Forwards all WhatsApp messages to Telegram
- 🖼️ Supports images, videos, audio, and documents
- 👥 Works with both private chats and groups
- 📍 Forwards location messages
- 💾 Saves WhatsApp session (no need to scan QR every time)

## Setup

### 1. Create a Telegram Bot

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the instructions
3. Copy the **Bot Token** you receive

### 2. Get Your Telegram Chat ID

1. Search for `@userinfobot` on Telegram
2. Start a chat with it
3. It will reply with your **Chat ID**

### 3. Configure the App

1. Copy `.env.example` to `.env`:
   ```bash
   copy .env.example .env
   ```

2. Edit `.env` and add your credentials:
   ```
   TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   TELEGRAM_CHAT_ID=123456789
   ```

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

Once connected, all incoming WhatsApp messages will be automatically forwarded to your Telegram chat.

Press `Ctrl+C` to stop the app gracefully.

## Notes

- The WhatsApp session is saved in `.wwebjs_auth/` folder
- Delete this folder if you want to log in with a different account
- Keep the app running to receive messages
- Works best on a computer that's always on (or a server)

## Troubleshooting

**QR code won't scan:**
- Make sure your WhatsApp is up to date
- Try deleting `.wwebjs_auth/` folder and restart

**Messages not forwarding:**
- Check your `.env` file has correct Telegram credentials
- Make sure you've started a chat with your bot first
- Verify your Chat ID is correct

**Puppeteer errors:**
- On Linux, you may need to install additional dependencies:
  ```bash
  sudo apt-get install -y libgbm-dev
  ```
