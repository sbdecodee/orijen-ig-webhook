// /api/webhook.js
import nodemailer from "nodemailer";

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";
const API_VERSION = process.env.META_API_VERSION || "v24.0";

// Instagram Messaging API
// OJO: este debe ser el token que funciona con graph.instagram.com (muchas veces empieza con IGAA...)
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";
// IG Business Account ID (el id 1784... que te sale en la sección de IG)
const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID || "";

// Facebook Page Messaging (opcional, solo si también quieres responder mensajes de la página)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || "";

// Email
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmail";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_TO_DEFAULT = process.env.EMAIL_TO_DEFAULT || "sbernal@decodeegroup.com";
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
// DEDUPE (evita reintentos / loops)
// =========================
// Cache en memoria (serverless). Ayuda muchísimo con duplicados por reintento.
globalThis.__SEEN_MIDS__ = globalThis.__SEEN_MIDS__ || new Map();

function seenMid(mid) {
  if (!mid) return false;
  const now = Date.now();
  const cache = globalThis.__SEEN_MIDS__;

  // Limpieza básica (TTL 10 min)
  for (const [k, ts] of cache.entries()) {
    if (now - ts > 10 * 60 * 1000) cache.delete(k);
  }

  if (cache.has(mid)) return true;
  cache.set(mid, now);
  return false;
}

// =========================
// EMAIL
// =========================
function getTransporter() {
  if (!EMAIL_USER || !EMAIL_PASS) return null;
  return nodemailer.createTransport({
    service: EMAIL_PROVIDER,
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
// GRAPH POST (con timeout+retries)
// =========================
async function graphPost({ baseUrl, path, payload, accessToken, retries = 2, timeoutMs = 8000 }) {
  const url = `${baseUrl}/${API_VERSION}/${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // IG Messaging usa Bearer OK, FB Page también lo acepta en muchos casos,
          // pero para FB Page también funciona ?access_token=. Aquí mantenemos Bearer.
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(t);

      const txt = await r.text();
      if (!r.ok) {
        console.error("GRAPH_ERROR", { url, status: r.status, body: txt });
        throw new Error(`Graph API ${r.status}: ${txt}`);
      }

      try {
        return JSON.parse(txt);
      } catch {
        return txt;
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

// IG DM Reply (Instagram Messaging API)
// Endpoint (según integration assistant): POST https://graph.instagram.com/vXX.X/me/messages
async function replyToIGDM(recipientId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("IG_DM_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text: message },
  };

  // IMPORTANTE: baseUrl = graph.instagram.com (no graph.facebook.com)
  return graphPost({
    baseUrl: "https://graph.instagram.com",
    path: "me/messages",
    payload,
    accessToken: IG_ACCESS_TOKEN,
  });
}

// FB Page DM Reply (solo si lo necesitas)
// Endpoint: POST https://graph.facebook.com/vXX.X/me/messages
async function replyToFBPageDM(psid, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("FB_DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }

  const payload = {
    recipient: { id: psid },
    message: { text: message },
  };

  return graphPost({
    baseUrl: "https://graph.facebook.com",
    path: "me/messages",
    payload,
    accessToken: PAGE_ACCESS_TOKEN,
  });
}

// Comentarios IG (si lo estás usando)
// OJO: comentarios sí van por graph.facebook.com usualmente (IG Graph)
async function replyToComment(commentId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("COMMENT_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }
  return graphPost({
    baseUrl: "https://graph.facebook.com",
    path: `${commentId}/replies`,
    payload: { message },
    accessToken: IG_ACCESS_TOKEN,
  });
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
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = req.body || {};
    console.log("WEBHOOK_IN", JSON.stringify(body));

    const objectType = body.object; // "instagram" o "page"
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // A) MENSAJES (entry.messaging)
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          // 1) Ignora mensajes eco del propio bot (evita loops)
          if (m?.message?.is_echo) continue;

          // 2) Ignora eventos técnicos (delivery/read/etc.)
          // Si no hay m.message, NO es un mensaje real del usuario.
          if (!m.message) continue;

          // 3) Dedup por message mid (evita reintentos/duplicados)
          const mid = m.message?.mid;
          if (seenMid(mid)) {
            console.log("DEDUP_SKIP", { mid });
            continue;
          }

          // 4) Obtén remitente + contenido
          const senderId = m.sender?.id;
          if (!senderId) continue;

          const text = typeof m.message?.text === "string" ? m.message.text : "";
          const hasAttachments = Array.isArray(m.message?.attachments) && m.message.attachments.length > 0;

          // Si no hay texto ni attachments, ignora
          if (!text && !hasAttachments) continue;

          const category = classify(text);
          const reply = buildAutoReply(category);

          // 5) Responder según el tipo de objeto
          try {
            if (objectType === "instagram") {
              // Instagram DM
              await replyToIGDM(senderId, reply);
              console.log("IG_DM_REPLIED", { senderId, category, mid });
            } else {
              // Facebook Page DM
              await replyToFBPageDM(senderId, reply);
              console.log("FB_DM_REPLIED", { senderId, category, mid });
            }
          } catch (e) {
            console.error("DM_REPLY_FAIL", String(e));
          }

          // 6) Escala por correo si aplica
          if (category !== "general") {
            await sendRoutingEmail({
              category,
              source: objectType === "instagram" ? "IG_DM" : "FB_DM",
              text: text || "(attachment)",
              meta: { senderId, mid, entryId: entry.id || null },
            });
          }
        }
      }

      // B) COMMENTS (entry.changes)
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
