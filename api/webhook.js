// /api/webhook.js
import nodemailer from "nodemailer";

/**
 * ORIJEN RD - Meta Webhook (IG + Messenger) - FINAL
 * - Usa PAGE_ACCESS_TOKEN como token principal (producción).
 * - IG_ACCESS_TOKEN queda como fallback opcional (si lo quieres usar).
 * - Responde DMs (Instagram / Messenger) vía Send API: POST /me/messages
 * - Responde comentarios IG vía: POST /{comment-id}/replies
 */

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";

// Token principal (producción)
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || ""; // ✅ Page token con permisos IG + FB

// Fallback opcional (no requerido si tu Page token ya tiene IG perms)
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";

// Email
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmail";
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_TO_DEFAULT =
  process.env.EMAIL_TO_DEFAULT || "sbernal@decodeegroup.com";

const EMAIL_TO_SALES = process.env.EMAIL_TO_SALES || EMAIL_TO_DEFAULT;
const EMAIL_TO_PRICING = process.env.EMAIL_TO_PRICING || EMAIL_TO_DEFAULT;
const EMAIL_TO_EMERGENCY = process.env.EMAIL_TO_EMERGENCY || EMAIL_TO_DEFAULT;

// =========================
// KEYWORDS
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
// GRAPH API
// =========================
async function graphPost(
  path,
  payload,
  accessToken,
  { retries = 2, timeoutMs = 9000 } = {}
) {
  if (!accessToken) throw new Error("Missing access token");

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

      const raw = await r.text();
      if (!r.ok) {
        console.error("GRAPH_ERROR", { path, status: r.status, body: raw });
        throw new Error(`Graph API ${r.status}: ${raw}`);
      }

      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    } catch (e) {
      clearTimeout(t);
      console.error("GRAPH_FETCH_FAIL", { path, attempt, error: String(e) });
      if (attempt === retries) throw e;
      await sleep(400 * (attempt + 1));
    }
  }
}

// =========================
// ACTIONS
// =========================

// ✅ Responder DM (IG o FB) via Send API
// Endpoint: POST /me/messages
async function replyToDM(recipientId, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }

  const payload = {
    recipient: { id: recipientId },
    message: { text: message },
  };

  return graphPost("me/messages", payload, PAGE_ACCESS_TOKEN);
}

// ✅ Responder comentario IG
// Endpoint: POST /{comment-id}/replies  { message }
async function replyToComment(commentId, message) {
  const tokenToUse = PAGE_ACCESS_TOKEN || IG_ACCESS_TOKEN;
  if (!tokenToUse) {
    console.warn("COMMENT_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN/IG_ACCESS_TOKEN");
    return;
  }

  return graphPost(`${commentId}/replies`, { message }, tokenToUse);
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
      /**
       * A) MENSAJES (DM)
       * Estructura típica:
       * entry.messaging[] con:
       * - sender.id (usuario)
       * - recipient.id (tu IG business id o page id)
       * - message.text
       */
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          const senderId = m.sender?.id; // el usuario que escribió
          const text = m.message?.text || "";

          // ignorar eco-messages
          if (m.message?.is_echo) continue;
          if (!senderId) continue;

          const category = classify(text);
          const reply = buildAutoReply(category);

          // 1) Responder DM
          try {
            await replyToDM(senderId, reply);
            console.log("DM_REPLIED", { senderId, category });
          } catch (e) {
            console.error("DM_REPLY_FAIL", String(e));
          }

          // 2) Email si aplica
          if (category !== "general") {
            await sendRoutingEmail({
              category,
              source: "DM",
              text,
              meta: {
                senderId,
                entryId: entry.id || null,
                object: body.object || null,
              },
            });
          }
        }
      }

      /**
       * B) COMMENTS
       * IG suele mandar:
       * entry.changes[] con field="comments" o "live_comments"
       * value.id (commentId), value.text, value.from
       */
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

            // 1) Responder comentario
            try {
              await replyToComment(commentId, reply);
              console.log("COMMENT_REPLIED", { commentId, category });
            } catch (e) {
              console.error("COMMENT_REPLY_FAIL", String(e));
            }

            // 2) Email si aplica
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

    // Meta requiere 200 rápido
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("WEBHOOK_FATAL", err);
    // devolver 200 para que Meta no reintente con spam
    return res.status(200).json({ ok: true });
  }
}
