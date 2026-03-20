// Paydos Turizm - Schengen Vize Randevu Takip Botu
// Vercel Cron ile her 5 dakikada çalışır
// VFS Global randevularını kontrol eder → Telegram'a bildirim gönderir

const VISA_API_URL = "https://api.visasbot.com/api/visa/list";

// Takip edilecek ülkeler (mission_code)
const TARGET_MISSIONS = ["fra", "bel", "pol", "esp"];

const MISSION_LABELS = {
  fra: "🇫🇷 Fransa",
  bel: "🇧🇪 Belçika",
  pol: "🇵🇱 Polonya",
  esp: "🇪🇸 İspanya",
};

// Upstash Redis - bildirim tekrarını önlemek için
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Telegram
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Redis Helpers ───────────────────────────────────────────────
async function redisGet(key) {
  if (!UPSTASH_URL) return null;
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    });
    const data = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

async function redisSet(key, value, exSeconds = 86400) {
  if (!UPSTASH_URL) return;
  try {
    await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/ex/${exSeconds}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
    );
  } catch {
    // sessizce devam et
  }
}

// ─── Telegram Helper ─────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
  return res.ok;
}

// ─── Randevu Kontrol ─────────────────────────────────────────────
async function fetchAppointments() {
  const res = await fetch(VISA_API_URL, {
    headers: {
      "User-Agent": "PapdosTurizm-VizeBot/1.0",
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`API yanıt vermedi: ${res.status}`);
  }

  const data = await res.json();

  // Array değilse sarmalıyorum
  const list = Array.isArray(data) ? data : data.data || data.appointments || [];

  return list;
}

function filterAppointments(appointments) {
  return appointments.filter((apt) => {
    const country = (apt.country_code || "").toLowerCase();
    const mission = (apt.mission_code || "").toLowerCase();
    const status = (apt.status || "").toLowerCase();

    return (
      country === "tur" &&
      TARGET_MISSIONS.includes(mission) &&
      (status === "open" || status === "waitlist_open")
    );
  });
}

function buildCacheKey(apt) {
  // Her randevu için benzersiz anahtar
  const mission = (apt.mission_code || "").toLowerCase();
  const center = (apt.center || "").replace(/\s+/g, "_");
  const visaType = (apt.visa_type || apt.subcategory || "").replace(/\s+/g, "_");
  const date = apt.appointment_date || apt.book_now_date || "nodate";
  return `paydos:${mission}:${center}:${visaType}:${date}`;
}

function formatMessage(apt) {
  const mission = (apt.mission_code || "").toLowerCase();
  const label = MISSION_LABELS[mission] || mission.toUpperCase();
  const status = (apt.status || "").toLowerCase();
  const statusEmoji = status === "open" ? "✅" : "⏳";
  const center = apt.center || "Bilinmiyor";
  const visaType = apt.visa_type || apt.subcategory || "Genel";
  const date = apt.appointment_date || apt.book_now_date || "Tarih yok";

  return [
    `${statusEmoji} *RANDEVU AÇILDI!*`,
    ``,
    `🌍 *Ülke:* ${label}`,
    `🏢 *Merkez:* ${center}`,
    `📄 *Tip:* ${visaType}`,
    `🗓️ *Tarih:* ${date}`,
    `🚦 *Durum:* ${status === "open" ? "Açık" : "Bekleme Listesi"}`,
    ``,
    `⏰ _${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}_`,
    `📌 _Paydos Turizm Vize Takip_`,
  ].join("\n");
}

// ─── Ana Handler ─────────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel Cron güvenlik kontrolü (opsiyonel)
  // const authHeader = req.headers["authorization"];
  // if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
  //   return res.status(401).json({ error: "Yetkisiz" });
  // }

  try {
    // 1. Randevuları çek
    const allAppointments = await fetchAppointments();

    // 2. Filtrele: Türkiye → Hedef ülkeler, sadece açık olanlar
    const openSlots = filterAppointments(allAppointments);

    if (openSlots.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Açık randevu yok",
        checked: allAppointments.length,
        time: new Date().toISOString(),
      });
    }

    // 3. Her açık randevu için bildirim gönder (tekrar olmayanlar)
    let sent = 0;
    let skipped = 0;

    for (const apt of openSlots) {
      const cacheKey = buildCacheKey(apt);
      const alreadySent = await redisGet(cacheKey);

      if (alreadySent) {
        skipped++;
        continue;
      }

      // Telegram'a gönder
      const msg = formatMessage(apt);
      const ok = await sendTelegram(msg);

      if (ok) {
        // 6 saat boyunca tekrar gönderme (21600 saniye)
        await redisSet(cacheKey, "1", 21600);
        sent++;
      }

      // Telegram rate limit - mesajlar arası 1 saniye bekle
      if (sent > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return res.status(200).json({
      ok: true,
      total: allAppointments.length,
      open: openSlots.length,
      sent,
      skipped,
      time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Hata:", error.message);

    // Kritik hata durumunda Telegram'a hata bildirimi (günde max 1)
    const errorCacheKey = "paydos:error:daily";
    const errorSent = await redisGet(errorCacheKey);
    if (!errorSent && TG_BOT_TOKEN) {
      await sendTelegram(`⚠️ *Vize Bot Hatası*\n\n\`${error.message}\`\n\n_Otomatik kontrol geçici olarak başarısız._`);
      await redisSet(errorCacheKey, "1", 3600); // 1 saat tekrarlama
    }

    return res.status(200).json({
      ok: false,
      error: error.message,
      time: new Date().toISOString(),
    });
  }
}
