// /api/webhook.js
import nodemailer from "nodemailer";

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";

// Tokens
// IG_ACCESS_TOKEN: para responder COMENTARIOS (Graph IG comment replies)
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";
// PAGE_ACCESS_TOKEN: para responder DMs vía /me/messages (Messenger platform / IG messaging)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";

// Email
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmail";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_TO_DEFAULT = process.env.EMAIL_TO_DEFAULT || "sbernal@decodeegroup.com";

// Opcionales por área (si no existen, cae al default)
const EMAIL_TO_SALES = process.env.EMAIL_TO_SALES || EMAIL_TO_DEFAULT;
const EMAIL_TO_PRICING = process.env.EMAIL_TO_PRICING || EMAIL_TO_DEFAULT;
const EMAIL_TO_EMERGENCY = process.env.EMAIL_TO_EMERGENCY || EMAIL_TO_DEFAULT;

// =========================
// KEYWORDS (ajústalas)
// =========================
const KW_PRICING = [
  "precio",
  "precios",
  "cuanto",
  "cuánto",
  "costo",
  "costos",
  "vale",
  "valor",
  "tarifa",
  "promoción",
  "promo",
];

const KW_SALES = [
  "comprar",
  "compra",
  "pedido",
  "orden",
  "cotizar",
  "cotización",
  "stock",
  "disponible",
  "envío",
  "delivery",
  "tienda",
  "distribuidor",
];

const KW_EMERGENCY = [
  "urgente",
  "emergencia",
  "intoxicación",
  "intoxicacion",
  "vomito",
  "vómito",
  "convulsión",
  "convulsion",
  "sangre",
  "accidente",
];

// =========================
// HELPERS
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
function hasAnyKeyword(text, list) {
  const t = norm(text);
  return list.some((k) => t.includes(norm(k)));
}
function classify(text) {
  if (hasAnyKeyword(text, KW_EMERGENCY)) return "emergency";
  if (hasAnyKeyword(text, KW_PRICING)) return "pricing";
  if (hasAnyKeyword(text, KW_SALES)) return "sales";
  return "general";
}
function pickEmail(category) {
  if (category === "emergency") return EMAIL_TO_EMERGENCY;
  if (category === "pricing") return EMAIL_TO_PRICING;
  if (category === "sales") return EMAIL_TO_SALES;
  return EMAIL_TO_DEFAULT;
}

function buildAutoReply(category) {
  if (category === "emergency") {
    return "¡Gracias por escribirnos! Por seguridad, si tu mascota presenta una situación urgente, contáctanos de inmediato por el canal de emergencias o llama a la clínica. Si puedes, envíanos: especie/edad, síntomas y desde cuándo inició.";
  }
  if (category === "pricing") {
    return "¡Claro! Te ayudamos con precios. Para cotizar exacto, dime el producto/servicio que necesitas y tu ubicación (si aplica). En breve te respondemos con el detalle.";
  }
  if (category === "sales") {
    return "¡Perfecto! Para ayudarte con tu compra, dime qué necesitas, cantidad y si es para entrega o recogida. Te respondemos con disponibilidad y pasos a seguir.";
  }
  return "¡Hola! Gracias por escribirnos 😊 ¿En qué te podemos ayudar hoy?";
}

// =========================
// SIMPLE DEDUPE (serverless best-effort)
// =========================
// Evita duplicados por reintentos de Meta o eventos repetidos.
// Nota: En serverless no es 100% persistente, pero reduce MUCHO el spam.
const GLOBAL_KEY = "__ORIJEN_DEDUPE_CACHE__";
function getCache() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = new Map(); // key -> expiresAt
  }
  return globalThis[GLOBAL_KEY];
}
function seenRecently(key, ttlMs = 10 * 60 * 1000) {
  if (!key) return false;
  const cache = getCache();
  const now = Date.now();

  // cleanup ligero
  if (cache.size > 1000) {
    for (const [k, exp] of cache.entries()) {
      if (exp <= now) cache.delete(k);
    }
  }

  const exp = cache.get(key);
  if (exp && exp > now) return true;

  cache.set(key, now + ttlMs);
  return false;
}

// =========================
// EMAIL
// =========================
function getTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) return null;

  return nodemailer.createTransport({
    service: EMAIL_PROVIDER, // "gmail"
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
}

async function sendRoutingEmail({ category, source, text, meta }) {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn("EMAIL_SKIPPED: Missing EMAIL_USER/EMAIL_PASS");
    return;
  }

  const to = pickEmail(category);
  const subject = `[Orijen Bot] ${category.toUpperCase()} - ${source}`;
  const body = [
    `Categoria: ${category}`,
    `Fuente: ${source}`,
    "",
    `Mensaje/Comentario:`,
    text || "(sin texto)",
    "",
    `Meta:`,
    JSON.stringify(meta || {}, null, 2),
  ].join("\n");

  await transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    text: body,
  });

  console.log("EMAIL_SENT", { to, category, source });
}

// =========================
// GRAPH API (timeout + retries + logs)
// =========================
async function graphPost(
  path,
  payload,
  accessToken,
  { retries = 2, timeoutMs = 8000 } = {}
) {
  const url = `https://graph.facebook.com/v24.0/${path}?access_token=${encodeURIComponent(
    accessToken
  )}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(t);

      const text = await r.text();
      if (!r.ok) {
        console.error("GRAPH_ERROR", { url, status: r.status, body: text });
        throw new Error(`Graph API ${r.status}: ${text}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      clearTimeout(t);
      console.error("GRAPH_FETCH_FAIL", { url, attempt, error: String(e) });

      if (attempt === retries) throw e;
      await sleep(350 * (attempt + 1));
    }
  }
}

// =========================
// ACTIONS
// =========================
async function replyToComment(commentId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("COMMENT_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }
  return graphPost(`${commentId}/replies`, { message }, IG_ACCESS_TOKEN);
}

async function replyToDM(psid, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }
  const payload = {
    recipient: { id: psid },
    message: { text: message },
  };
  return graphPost(`me/messages`, payload, PAGE_ACCESS_TOKEN);
}

// =========================
// WEBHOOK HANDLER
// =========================
export default async function handler(req, res) {
  // 1) VERIFICACIÓN (Meta)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // 2) EVENTOS
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const body = req.body || {};
    console.log("WEBHOOK_IN", JSON.stringify(body));

    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // =========================
      // A) MENSAJES (DM)
      // =========================
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          // 0) IGNORA eventos que NO son mensaje
          if (m.delivery || m.read || m.postback || m.optin) continue;

          // 1) IGNORA eco del bot
          if (m.message?.is_echo) continue;

          const psid = m.sender?.id;
          if (!psid) continue;

          // 2) PROCESA SOLO si hay mensaje real (texto o attachments)
          const hasText = typeof m.message?.text === "string" && m.message.text.trim().length > 0;
          const hasAttachments = Array.isArray(m.message?.attachments) && m.message.attachments.length > 0;

          if (!hasText && !hasAttachments) {
            // Si llega algo raro sin texto/attachments, NO respondas
            continue;
          }

          // 3) DEDUPE por message id (mid)
          const mid = m.message?.mid;
          if (mid && seenRecently(`dm:${mid}`)) {
            console.log("DM_DUPLICATE_SKIPPED", { mid });
            continue;
          }

          const text = hasText ? m.message.text : "[attachment]";
          const category = classify(text);
          const reply = buildAutoReply(category);

          // 4) Responde
          try {
            await replyToDM(psid, reply);
            console.log("DM_REPLIED", { psid, category, mid: mid || null });
          } catch (e) {
            console.error("DM_REPLY_FAIL", String(e));
          }

          // 5) Escala por correo solo si tiene texto y no es general
          if (hasText && category !== "general") {
            try {
              await sendRoutingEmail({
                category,
                source: "DM",
                text,
                meta: { psid, mid: mid || null, entryId: entry.id || null },
              });
            } catch (e) {
              console.error("EMAIL_FAIL", String(e));
            }
          }
        }
      }

      // =========================
      // B) COMMENTS (comentarios)
      // =========================
      if (Array.isArray(entry.changes)) {
        for (const c of entry.changes) {
          const field = c.field;
          const value = c.value || {};

          if (field === "comments" || field === "live_comments") {
            const text = value.text || "";
            const commentId = value.id;
            const from = value.from?.username || value.from?.id || "unknown";

            if (!commentId) continue;

            // DEDUPE comentarios
            if (seenRecently(`cmt:${commentId}`)) {
              console.log("COMMENT_DUPLICATE_SKIPPED", { commentId });
              continue;
            }

            const category = classify(text);
            const reply = buildAutoReply(category);

            try {
              await replyToComment(commentId, reply);
              console.log("COMMENT_REPLIED", { commentId, category });
            } catch (e) {
              console.error("COMMENT_REPLY_FAIL", String(e));
            }

            if (category !== "general") {
              try {
                await sendRoutingEmail({
                  category,
                  source: "COMMENT",
                  text,
                  meta: { commentId, from, field },
                });
              } catch (e) {
                console.error("EMAIL_FAIL", String(e));
              }
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WEBHOOK_FATAL", err);
    // Importante: 200 para que Meta no reintente agresivamente
    return res.status(200).json({ ok: true });
  }
}
