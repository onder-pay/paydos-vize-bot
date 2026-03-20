# 🛂 Paydos Vize Randevu Takip Botu

VFS Global üzerinden Schengen vize randevularını otomatik takip eden ve Telegram'a bildirim gönderen bot.

## Takip Edilen Ülkeler

| Ülke | Kod |
|------|-----|
| 🇫🇷 Fransa | `fra` |
| 🇧🇪 Belçika | `bel` |
| 🇵🇱 Polonya | `pol` |
| 🇪🇸 İspanya | `esp` |

## Nasıl Çalışır

1. Vercel Cron her **5 dakikada** bir `/api/check` endpoint'ini tetikler
2. `api.visasbot.com` API'sinden tüm randevu verileri çekilir
3. Türkiye → hedef ülkeler filtrelenir, sadece **açık** veya **bekleme listesi** olanlar alınır
4. Daha önce bildirilmemiş randevular **Telegram'a** gönderilir
5. Upstash Redis ile **6 saat** boyunca aynı randevu tekrar bildirilmez

## Kurulum (10 dakika)

### 1. Telegram Bot Oluştur

1. Telegram'da [@BotFather](https://t.me/BotFather)'a git
2. `/newbot` yaz → Bot adı: `PaydosVizeBot` (veya istediğin)
3. **Bot Token**'ı kaydet
4. Bir Telegram **grubu** oluştur, botu gruba ekle
5. Chat ID'yi bul:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Grup mesajı gönder, response'daki `chat.id` değerini al (genelde `-100...` ile başlar)

### 2. Upstash Redis (Ücretsiz)

1. [console.upstash.com](https://console.upstash.com) → Kayıt ol
2. **Create Database** → Region: `eu-west-1` (Frankfurt)
3. **REST API** sekmesinden URL ve Token'ı kopyala

### 3. Vercel'e Deploy Et

1. Bu repo'yu GitHub'a push et
2. [vercel.com](https://vercel.com) → **Import Project** → GitHub repo seç
3. **Environment Variables** ekle:

| Değişken | Değer |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | BotFather'dan aldığın token |
| `TELEGRAM_CHAT_ID` | Grup/kanal chat ID |
| `UPSTASH_REDIS_REST_URL` | Upstash REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST Token |

4. **Deploy** → Bitti!

### 4. Test Et

Deploy sonrası tarayıcıda aç:
```
https://paydos-vize-bot.vercel.app/api/check
```

JSON yanıt görmelisin:
```json
{
  "ok": true,
  "total": 150,
  "open": 2,
  "sent": 2,
  "skipped": 0,
  "time": "2026-03-20T14:00:00.000Z"
}
```

## Ülke Ekle/Çıkar

`api/check.js` içindeki bu satırları düzenle:

```js
const TARGET_MISSIONS = ["fra", "bel", "pol", "esp"];
```

Yaygın VFS mission kodları: `deu` (Almanya), `ita` (İtalya), `nld` (Hollanda), `aut` (Avusturya), `grc` (Yunanistan), `cze` (Çekya)

## Bildirim Örneği

```
✅ RANDEVU AÇILDI!

🌍 Ülke: 🇫🇷 Fransa
🏢 Merkez: France Visa Application Centre - Istanbul
📄 Tip: TOURISM VISA APPLICATION
🗓️ Tarih: 15/07/2026
🚦 Durum: Açık

⏰ 20.03.2026 17:00:00
📌 Paydos Turizm Vize Takip
```

## Maliyet

| Servis | Plan | Maliyet |
|--------|------|---------|
| Vercel | Hobby | **Ücretsiz** |
| Upstash Redis | Free | **Ücretsiz** (10K istek/gün) |
| Telegram Bot API | - | **Ücretsiz** |
| **Toplam** | | **$0/ay** |

## Önemli Notlar

- `api.visasbot.com` üçüncü parti bir servis — dönem dönem çalışmayabilir
- Bot randevu **almaz**, sadece **bildirim** gönderir
- Aynı randevu 6 saat içinde tekrar bildirilmez
- Hata durumunda saatte max 1 hata bildirimi gönderilir
