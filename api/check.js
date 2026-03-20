// Paydos Turizm - Schengen Vize Randevu Takip Botu
// İki farklı API kaynağı dener (fallback)

const APIS = [
  "https://api.schengenvisaappointments.com/api/visa-list/?format=json",
  "https://api.visasbot.com/api/visa/list",
];

const TARGET_MISSIONS = ["fra", "bel", "pol", "esp"];

const MISSION_LABELS = {
  fra: "🇫🇷 Fransa",
  bel: "🇧🇪 Belçika",
  pol: "🇵🇱 Polonya",
  esp: "🇪🇸 İspanya",
};

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
  } catch {}
}

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

async function fetchAppointments() {
  let lastError = null;

  for (const apiUrl of APIS) {
    try {
      const res = await fetch(apiUrl, {
        headers: {
          "User-Agent": "PaydosTurizm-VizeBot/1.0",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        lastError = `${apiUrl} => ${res.status}`;
        continue;
      }

      const data = await res.json();
      const list = Array.isArray(data) ? data : data.data || data.results || data.appointments || [];

      if (list.length > 0) {
        return { list, source: apiUrl };
      }

      lastError = `${apiUrl} => bos liste`;
    } catch (err) {
      lastError = `${apiUrl} => ${err.message}`;
      continue;
    }
  }

  throw new Error(`Tum API'ler basarisiz: ${lastError}`);
}

function filterAppointments(appointments) {
  return appointments.filter((apt) => {
    const country = (apt.country_code || "").toLowerCase();
    const mission = (apt.mission_code || "").toLowerCase();
    const status = (apt.status || apt.appointment_status || "").toLowerCase();

    return (
      country === "tur" &&
      TARGET_MISSIONS.includes(mission) &&
      (status === "open" || status === "waitlist_open")
    );
  });
}

function buildCacheKey(apt) {
  const mission = (apt.mission_code || "").toLowerCase();
  const center = (apt.center || apt.center_name || "").replace(/\s+/g, "_").substring(0, 50);
  const visaType = (apt.visa_type || apt.subcategory || "").replace(/\s+/g, "_").substring(0, 30);
  const date = apt.appointment_date || apt.book_now_date || "nodate";
  return `paydos:${mission}:${center}:${visaType}:${date}`;
}

function formatMessage(apt) {
  const mission = (apt.mission_code || "").toLowerCase();
  const label = MISSION_LABELS[mission] || mission.toUpperCase();
  const status = (apt.status || apt.appointment_status || "").toLowerCase();
  const statusEmoji = status === "open" ? "✅" : "⏳";
  const center = apt.center || apt.center_name || "Bilinmiyor";
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

export default async function handler(req, res) {
  try {
    const { list, source } = await fetchAppointments();
    const openSlots = filterAppointments(list);

    if (openSlots.length === 0) {
      return res.status(200).json({
        ok: true,
        message: "Açık randevu yok",
        checked: list.length,
        source,
        time: new Date().toISOString(),
      });
    }

    let sent = 0;
    let skipped = 0;

    for (const apt of openSlots) {
      const cacheKey = buildCacheKey(apt);
      const alreadySent = await redisGet(cacheKey);

      if (alreadySent) {
        skipped++;
        continue;
      }

      const msg = formatMessage(apt);
      const ok = await sendTelegram(msg);

      if (ok) {
        await redisSet(cacheKey, "1", 21600);
        sent++;
      }

      if (sent > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return res.status(200).json({
      ok: true,
      total: list.length,
      open: openSlots.length,
      sent,
      skipped,
      source,
      time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Hata:", error.message);

    const errorCacheKey = "paydos:error:daily";
    const errorSent = await redisGet(errorCacheKey);
    if (!errorSent && TG_BOT_TOKEN) {
      await sendTelegram(
        `⚠️ *Vize Bot Hatası*\n\n\`${error.message}\`\n\n_Otomatik kontrol geçici olarak başarısız._`
      );
      await redisSet(errorCacheKey, "1", 3600);
    }

    return res.status(200).json({
      ok: false,
      error: error.message,
      time: new Date().toISOString(),
    });
  }
}
