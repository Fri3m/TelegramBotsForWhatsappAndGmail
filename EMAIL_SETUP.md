# Email Bot Setup Guide

Bu doküman email bot'unun nasıl kurulacağını açıklar.

## 1. Gmail App Password Oluştur

Gmail hesaptan "uygulama şifresi" oluşturmalısın (normal şifre çalışmaz):

1. Google Account'una git: https://myaccount.google.com
2. Sol menüden "Güvenlik" (Security) seç
3. 2-Adımlı Doğrulama'yı etkinleştir (eğer daha yapılmadıysa)
4. Sayfa aşağısında "Uygulama şifreleri" (App passwords) bul
5. Cihaz: "Mail", İşletim Sistemi: "Linux" seç
6. 16 karakterlik şifreyi kopyala

## 2. Email Bot Config Dosyası Oluştur

`bots/` klasörüne yeni bir JSON dosyası oluştur. Örneğin `bots/email-bot.json`:

```json
{
  "name": "Email Bot",
  "mode": "email",
  "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE",
  "chatId": "YOUR_TELEGRAM_CHAT_ID_HERE",
  "gmail_email": "your-email@gmail.com",
  "gmail_password": "app-password-16-chars"
}
```

### Açıklama:

- `name`: Bot'un anlaşılır adı
- `mode`: **"email"** olmalı
- `token`: @BotFather'dan aldığın Telegram bot token'u
- `chatId`: Mesajları almak istediğin Telegram chat ID'si
- `gmail_email`: Gmail hesap email adresi
- `gmail_password`: Gmail 16-karakterlik uygulama şifresi

## 3. Bot Komutları

Email bot aşağıdaki komutlara sahiptir:

```
/start - Yardım ve komut listesi göster
/emails - Son mailleri göster (max 10)
/search <kelime> - Maillerde arama yap
```

### Otomatik Check

Bot her 5 dakikada bir yeni mailleri kontrol eder ve varsa Telegram'a gönderir.

## 4. Telegram Chat ID Bulma

Senin Telegram chat ID'nini bulmak için:

1. @userinfobot'a `/start` gönder
2. Dönen mesajda "Id: XXXXXXX" kısmını kopyala
3. Bunu `chatId` olarak kullan

## 5. Sorun Giderme

### "Email config missing" hatası

- Config dosyasında `gmail_email` ve `gmail_password` ayarlandı mı kontrol et
- Email adresi ve şifre doğru mu kontrol et

### IMAP bağlantı hatası

- Gmail IMAP erişimi etkinleştirilmiş mi kontrol et: https://support.google.com/mail/answer/7126229
- Gmail 2-Adımlı Doğrulamayı etkinleştirmişsen, uygulama şifresi kullanmalısın (normal şifre çalışmaz)

### Yeni mailler görünmüyor

- `/emails` komutu ile manuel olarak kontrol et
- Bot loglarında hata var mı kontrol et
- Gmail'de düzgün şekilde login olmuş musun?

## 6. Multiple Bots

General, Connection ve Email botlarını aynı anda çalıştırabilirsin:

```
bots/general-bot.json     (mode: "general")
bots/connection-bot.json  (mode: "connection")
bots/email-bot.json       (mode: "email")
```

Her bot kendi Telegram token'u ile çalışır ve bağımsız komutlara sahiptir.
