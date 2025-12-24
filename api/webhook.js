// /api/webhook.js
import nodemailer from "nodemailer";

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";

// Tokens
// IMPORTANTe: Para responder DMs (IG/FB) usa Page Access Token (Messenger API).
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || ""; // Messenger/IG DMs via /me/messages
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";     // Instagram Graph (comentarios / replies)

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
  "precio", "precios", "cuanto", "cuánto", "costo", "costos", "vale", "valor", "tarifa", "promoción", "promo",
];

const KW_SALES = [
  "comprar", "compra", "pedido", "orden", "cotizar", "cotización", "stock", "disponible", "envío", "delivery", "tienda", "distribuidor",
];

const KW_EMERGENCY = [
  "urgente", "emergencia", "intoxicación", "intoxicacion", "vomito", "vómito", "convulsión", "convulsion", "sangre", "accidente",
];

// =========================
// HELPERS
// =========================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s = "") {
  return String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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
    return "¡Claro! Te ayudamos con precios. Para cotizar exacto, dime el producto que necesitas y tu ubicación (si aplica). En breve te respondemos con el detalle.";
  }
  if (category === "sales") {
    return "¡Perfecto! Para ayudarte con tu compra, dime qué necesitas, cantidad y si es para entrega o recogida. Te respondemos con disponibilidad y pasos a seguir.";
  }
  return "¡Hola! Gracias por escribirnos 😊 ¿En qué te podemos ayudar hoy?";
}

// =========================
// DEDUPE (anti-loop / anti-retry)
// =========================
// Meta a veces reintenta o envía múltiples eventos por el mismo mensaje.
// Guardamos mid->timestamp por un rato para NO contestar repetido.
const SEEN_TTL_MS = 5 * 60 * 1000; // 5 min
const seen = new Map(); // mid -> ts

function pruneSeen(now = Date.now()) {
  for (const [k, ts] of seen.entries()) {
    if (now - ts > SEEN_TTL_MS) seen.delete(k);
  }
}
function alreadySeen(mid) {
  if (!mid) return false;
  const now = Date.now();
  pruneSeen(now);
  if (seen.has(mid)) return true;
  seen.set(mid, now);
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
async function graphPost(path, payload, accessToken, { retries = 2, timeoutMs = 8000 } = {}) {
  const url = `https://graph.facebook.com/v24.0/${path}?access_token=${encodeURIComponent(accessToken)}`;

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
        console.error("GRAPH_ERROR", { path, status: r.status, body: text });
        throw new Error(`Graph API ${r.status}: ${text}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (e) {
      clearTimeout(t);
      console.error("GRAPH_FETCH_FAIL", { path, attempt, error: String(e) });

      if (attempt === retries) throw e;
      await sleep(350 * (attempt + 1));
    }
  }
}

// =========================
// ACTIONS
// =========================

// Responder comentario IG:
// Endpoint: /{comment-id}/replies  { message: "..." }
async function replyToComment(commentId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("COMMENT_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }
  return graphPost(`${commentId}/replies`, { message }, IG_ACCESS_TOKEN);
}

// Responder DM (IG o FB) vía Messenger API:
// Endpoint: /me/messages con PAGE_ACCESS_TOKEN
async function replyToDM(psid, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }
  const payload = {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
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
    const object = body.object || "unknown";

    console.log("WEBHOOK_IN", JSON.stringify(body));

    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // =========================
      // A) MENSAJES (DM)
      // =========================
      // Meta manda muchos tipos de eventos en entry.messaging:
      // - message.text (lo que queremos)
      // - delivery / read / postback / referral / etc. (NO responder)
      if (Array.isArray(entry.messaging)) {
        const entryId = String(entry.id || ""); // en IG: IG business id; en FB: page id

        for (const m of entry.messaging) {
          // 0) Ignora eventos no-mensaje (reads/deliveries/etc.)
          if (m.delivery || m.read || m.postback || m.referral || m.optin) continue;

          // 1) Solo responder si hay texto REAL
          const text = m?.message?.text;
          if (typeof text !== "string" || !text.trim()) continue;

          // 2) Ignora eco-messages del propio sistema
          if (m?.message?.is_echo) continue;

          // 3) Dedupe por message id (evita retries/duplicados)
          const mid = m?.message?.mid;
          if (alreadySeen(mid)) {
            console.log("DM_DUPLICATE_SKIPPED", { mid });
            continue;
          }

          const senderId = String(m?.sender?.id || "");
          if (!senderId) continue;

          // 4) Ignora mensajes que "parecen" salir de tu propia cuenta/page (previene loops raros)
          // (en IG suele venir entry.id como tu IG business id)
          if (entryId && senderId === entryId) continue;

          const category = classify(text);
          const reply = buildAutoReply(category);

          // Responde
          try {
            await replyToDM(senderId, reply);
            console.log("DM_REPLIED", { object, senderId, category, mid });
          } catch (e) {
            console.error("DM_REPLY_FAIL", { object, senderId, error: String(e) });
          }

          // Escala por correo si aplica
          if (category !== "general") {
            await sendRoutingEmail({
              category,
              source: object === "instagram" ? "IG_DM" : "DM",
              text,
              meta: { senderId, entryId: entry.id || null, mid },
            });
          }
        }
      }

      // =========================
      // B) COMMENTS (comentarios)
      // =========================
      // Estructura común: entry.changes[] con field = "comments" o "live_comments"
      if (Array.isArray(entry.changes)) {
        for (const c of entry.changes) {
          const field = c.field;
          const value = c.value || {};

          if (field === "comments" || field === "live_comments") {
            const text = value.text || "";
            const commentId = value.id;
            const from = value.from?.username || value.from?.id || "unknown";

            if (!commentId) continue;

            const category = classify(text);
            const reply = buildAutoReply(category);

            try {
              await replyToComment(commentId, reply);
              console.log("COMMENT_REPLIED", { commentId, category });
            } catch (e) {
              console.error("COMMENT_REPLY_FAIL", String(e));
            }

            if (category !== "general") {
              await sendRoutingEmail({
                category,
                source: "COMMENT",
                text,
                meta: { commentId, from, field },
              });
            }
          }
        }
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WEBHOOK_FATAL", err);
    return res.status(200).json({ ok: true });
  }
}
