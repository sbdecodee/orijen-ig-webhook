// /api/webhook.js
import nodemailer from "nodemailer";

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";

// Instagram Messaging (token IGA... del asistente / Instagram Login)
const IG_ACCESS_TOKEN = (process.env.IG_ACCESS_TOKEN || "").trim();

// Facebook Page Messenger (si usas FB Messenger)
const PAGE_ACCESS_TOKEN = (process.env.PAGE_ACCESS_TOKEN || "").trim();

// Email
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmail";
const EMAIL_USER = (process.env.EMAIL_USER || "").trim();
const EMAIL_PASS = (process.env.EMAIL_PASS || "").trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || EMAIL_USER).trim();
const EMAIL_TO_DEFAULT = (process.env.EMAIL_TO_DEFAULT || "sbernal@decodeegroup.com").trim();

// Opcionales por área
const EMAIL_TO_SALES = (process.env.EMAIL_TO_SALES || EMAIL_TO_DEFAULT).trim();
const EMAIL_TO_PRICING = (process.env.EMAIL_TO_PRICING || EMAIL_TO_DEFAULT).trim();
const EMAIL_TO_EMERGENCY = (process.env.EMAIL_TO_EMERGENCY || EMAIL_TO_DEFAULT).trim();

// =========================
// KEYWORDS
// =========================
const KW_PRICING = ["precio", "precios", "cuanto", "cuánto", "costo", "costos", "vale", "valor", "tarifa", "promoción", "promo"];
const KW_SALES = ["comprar", "compra", "pedido", "orden", "cotizar", "cotización", "stock", "disponible", "envío", "delivery", "tienda", "distribuidor"];
const KW_EMERGENCY = ["urgente", "emergencia", "intoxicación", "intoxicacion", "vomito", "vómito", "convulsión", "convulsion", "sangre", "accidente"];

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
// HTTP helpers
// =========================
async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await r.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch {}

    if (!r.ok) {
      const err = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new Error(`${r.status} ${r.statusText} :: ${err}`);
    }

    return parsed;
  } finally {
    clearTimeout(t);
  }
}

async function withRetries(fn, { retries = 2 } = {}) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      console.error("REQ_FAIL", { attempt: i, error: String(e) });
      if (i === retries) throw e;
      await sleep(350 * (i + 1));
    }
  }
}

// =========================
// ACTIONS
// =========================

// ✅ IG DM reply (Instagram Messaging API)
// Usa el mismo endpoint que te muestra el Asistente: graph.instagram.com/v21.0/me/messages
async function replyToIGDM(recipientId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("IG_DM_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }

  const url = "https://graph.instagram.com/v21.0/me/messages";
  return withRetries(() =>
    httpJson(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${IG_ACCESS_TOKEN}`,
      },
      body: {
        recipient: { id: String(recipientId) },
        message: { text: message },
      },
    })
  );
}

// ✅ Facebook Page Messenger reply (opcional)
async function replyToFBPageDM(psid, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("FB_DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v24.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  return withRetries(() =>
    httpJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {
        recipient: { id: String(psid) },
        message: { text: message },
      },
    })
  );
}

// ✅ IG comment reply (Graph API)
async function replyToComment(commentId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("COMMENT_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }

  // Para comentarios suele funcionar con graph.facebook.com + access_token
  const url = `https://graph.facebook.com/v24.0/${commentId}/replies?access_token=${encodeURIComponent(IG_ACCESS_TOKEN)}`;

  return withRetries(() =>
    httpJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { message },
    })
  );
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

    const object = body.object; // "instagram" o "page"
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // =========================
      // A) DM (Instagram o Page)
      // =========================
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          // Ignorar eco mensajes
          if (m.message?.is_echo) continue;

          const text = m.message?.text || "";
          const senderId = m.sender?.id; // el id del usuario que escribió

          if (!senderId) continue;

          const category = classify(text);
          const reply = buildAutoReply(category);

          try {
            if (object === "instagram") {
              await replyToIGDM(senderId, reply);
              console.log("IG_DM_REPLIED", { senderId, category });
            } else if (object === "page") {
              await replyToFBPageDM(senderId, reply);
              console.log("FB_DM_REPLIED", { senderId, category });
            } else {
              console.warn("DM_SKIPPED_UNKNOWN_OBJECT", object);
            }
          } catch (e) {
            console.error("DM_REPLY_FAIL", { object, error: String(e) });
          }

          // Escalar por correo si aplica
          if (category !== "general") {
            await sendRoutingEmail({
              category,
              source: object === "instagram" ? "IG_DM" : "FB_DM",
              text,
              meta: { senderId, entryId: entry.id || null },
            });
          }
        }
      }

      // =========================
      // B) COMMENTS (IG)
      // =========================
      if (Array.isArray(entry.changes)) {
        for (const c of entry.changes) {
          const field = c.field;
          const value = c.value || {};

          // Comentarios (depende del producto puede variar)
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
    console.error("WEBHOOK_FATAL", String(err));
    // Meta requiere 200 para no reintentar en bucle
    return res.status(200).json({ ok: true });
  }
}
