// /api/webhook.js
import nodemailer from "nodemailer";

// =========================
// ENV
// =========================
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";
const API_VERSION = process.env.META_API_VERSION || "v24.0";

// Instagram Messaging API
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN || "";
const IG_BUSINESS_ID = process.env.IG_BUSINESS_ID || "";

// Facebook Page Messaging (opcional)
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
// KEYWORDS
// =========================
const KW_PRICING = [
  "precio", "precios", "cuanto", "cuánto", "costo", "costos", "vale", "valor", "tarifa", "promoción", "promo",
];

const KW_SALES = [
  "comprar", "compra", "pedido", "orden", "cotizar", "cotización", "stock", "disponible",
  "tienda", "distribuidor", "donde consigo", "dónde consigo", "donde comprar", "dónde comprar",
  "punto de venta", "puntos de venta", "donde lo consigo", "dónde lo consigo",
];

const KW_EMERGENCY = [
  "urgente", "emergencia", "intoxicación", "intoxicacion", "vomito", "vómito", "convulsión", "convulsion", "sangre", "accidente",
];

// =========================
// FAQ MENU (primer mensaje)
// =========================
const FAQ_MENU = [
  "¡Hola! Gracias por escribirnos a Orijen RD 😊",
  "",
  "Para ayudarte más rápido, responde con el número de una opción:",
  "1) Precios / cotización",
  "2) Dónde conseguirlo (puntos de venta)",
  "3) Recomendación según tu mascota",
  "4) Ingredientes / beneficios / composición",
  "5) Disponibilidad de una fórmula específica",
  "",
  "📍 Importante: para recomendarte el punto de venta ideal, te vamos a pedir tu *ciudad y sector*.",
  "⚠️ Si es una urgencia, escribe: *URGENTE*",
].join("\n");

function parseMenuSelection(text = "") {
  const t = norm(text).trim();
  if (!t) return null;

  if (["1", "2", "3", "4", "5"].includes(t)) return t;

  if (t.includes("precio") || t.includes("cotiz") || t.includes("costo") || t.includes("valor")) return "1";
  if (t.includes("donde") || t.includes("dónde") || t.includes("conseguir") || t.includes("punto") || t.includes("tienda")) return "2";
  if (t.includes("recom") || t.includes("cachorro") || t.includes("adult") || t.includes("senior") || t.includes("raza") || t.includes("gat") || t.includes("perr")) return "3";
  if (t.includes("ingred") || t.includes("benef") || t.includes("compos") || t.includes("prote") || t.includes("grasa")) return "4";
  if (t.includes("stock") || t.includes("dispon") || t.includes("hay") || t.includes("tienen") || t.includes("formula") || t.includes("fórmula")) return "5";

  return null;
}

function buildFaqReply(option) {
  switch (option) {
    case "1":
      return "¡Claro! 🧾 Para darte información de donde conseguirlo, dime:\n• Producto/fórmula\n• Presentación (kg/lb)\n• Tu *ciudad y sector*";
    case "2":
      return "¡Perfecto! 📍 Dime tu *ciudad y sector* y te recomendamos el punto de venta más cercano o el que más te convenga.";
    case "3":
      return "🐶🐱 ¡Te ayudamos a elegir! Dime:\n• Especie (perro/gato)\n• Edad\n• Peso aproximado\n• Objetivo (piel, digestión, energía, control de peso, etc.)\n• Si tiene alergias/sensibilidades\n• Tu *ciudad y sector* (para decirte dónde conseguirlo)";
    case "4":
      return "¡Claro! ¿Qué fórmula te interesa? Te compartimos ingredientes clave y beneficios. Si me dices tu *ciudad y sector*, también te indico dónde conseguirla.";
    case "5":
      return "✅ Para confirmarte disponibilidad, dime:\n• Fórmula exacta\n• Presentación\n• Tu *ciudad y sector*\nY te decimos dónde la puedes conseguir.";
    default:
      return "Perfecto 😊 ¿Cuál opción eliges (1–5)?";
  }
}

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
    return "¡Gracias por escribirnos! Por seguridad, si tu mascota presenta una situación urgente, contáctanos de inmediato por el canal de emergencias o llama a tu veterinario de confianza. Si puedes, envíanos: especie/edad, síntomas y desde cuándo inició.";
  }
  if (category === "pricing") {
    return "¡Claro! 🧾 Para darte el precio correcto y recomendarte el punto de venta ideal, dime el producto/fórmula, la presentación y tu *ciudad y sector*.";
  }
  if (category === "sales") {
    return "¡Perfecto! 📍 Para decirte dónde conseguirlo (puntos de venta), dime qué producto/fórmula buscas, la presentación y tu *ciudad y sector*.";
  }
  return "¡Hola! Gracias por escribirnos 😊 ¿En qué te podemos ayudar hoy?";
}

// Comentarios: CTA a DM (NO “te enviamos DM”, sino “contáctanos por DM”)
function buildCommentToDM(category) {
  if (category === "emergency") {
    return "⚠️ Para poder asistirte, por favor *contáctanos por Mensaje Directo* con síntomas + desde cuándo. Si es grave, acude a una clínica/veterinario de inmediato.";
  }
  // pricing / sales / puntos de venta
  return "¡Gracias! Por favor *contáctanos por Mensaje Directo* con tu *ciudad y sector* para poder asistirte y recomendarte el punto de venta ideal 😊";
}

// =========================
// DEDUPE + LOCK + 24H MENU STATE
// =========================
globalThis.__SEEN_MIDS__ = globalThis.__SEEN_MIDS__ || new Map();
globalThis.__SEEN_EVENTS__ = globalThis.__SEEN_EVENTS__ || new Map();
globalThis.__LOCKS__ = globalThis.__LOCKS__ || new Map();
globalThis.__MENU_STATE__ = globalThis.__MENU_STATE__ || new Map();

const TTL_10_MIN = 10 * 60 * 1000;
const TTL_60_SEC = 60 * 1000;
const MENU_24H = 24 * 60 * 60 * 1000;

function cleanupMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, ts] of map.entries()) {
    if (now - ts > ttlMs) map.delete(k);
  }
}
function seenMid(mid) {
  if (!mid) return false;
  const now = Date.now();
  const cache = globalThis.__SEEN_MIDS__;
  cleanupMap(cache, TTL_10_MIN);
  if (cache.has(mid)) return true;
  cache.set(mid, now);
  return false;
}
function seenEventKey(key) {
  if (!key) return false;
  const now = Date.now();
  const cache = globalThis.__SEEN_EVENTS__;
  cleanupMap(cache, TTL_10_MIN);
  if (cache.has(key)) return true;
  cache.set(key, now);
  return false;
}
async function withUserLock(userId, fn) {
  if (!userId) return fn();

  const locks = globalThis.__LOCKS__;
  cleanupMap(locks, TTL_60_SEC);

  if (locks.has(userId)) {
    await sleep(250);
    if (locks.has(userId)) {
      console.log("LOCK_SKIP", { userId });
      return;
    }
  }

  locks.set(userId, Date.now());
  try {
    return await fn();
  } finally {
    locks.delete(userId);
  }
}
function shouldShowMenuNow(senderId) {
  const now = Date.now();
  const s = globalThis.__MENU_STATE__.get(senderId);
  if (!s) return true;
  return now - (s.lastMenuAt || 0) > MENU_24H;
}
function markMenuShown(senderId) {
  globalThis.__MENU_STATE__.set(senderId, { lastMenuAt: Date.now() });
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

  await transporter.sendMail({ from: EMAIL_FROM, to, subject, text: body });
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
async function replyToIGDM(recipientId, message) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("IG_DM_REPLY_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }
  return graphPost({
    baseUrl: "https://graph.instagram.com",
    path: "me/messages",
    payload: { recipient: { id: recipientId }, message: { text: message } },
    accessToken: IG_ACCESS_TOKEN,
  });
}
async function replyToFBPageDM(psid, message) {
  if (!PAGE_ACCESS_TOKEN) {
    console.warn("FB_DM_REPLY_SKIPPED: Missing PAGE_ACCESS_TOKEN");
    return;
  }
  return graphPost({
    baseUrl: "https://graph.facebook.com",
    path: "me/messages",
    payload: { recipient: { id: psid }, message: { text: message } },
    accessToken: PAGE_ACCESS_TOKEN,
  });
}
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
async function likeComment(commentId) {
  if (!IG_ACCESS_TOKEN) {
    console.warn("COMMENT_LIKE_SKIPPED: Missing IG_ACCESS_TOKEN");
    return;
  }
  return graphPost({
    baseUrl: "https://graph.facebook.com",
    path: `${commentId}/likes`,
    payload: {},
    accessToken: IG_ACCESS_TOKEN,
  });
}

// =========================
// WEBHOOK HANDLER
// =========================
export default async function handler(req, res) {
  // Verify
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Verification failed");
  }

  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

  try {
    const body = req.body || {};
    console.log("WEBHOOK_IN", JSON.stringify(body));

    const objectType = body.object; // "instagram" o "page"
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      // ============ A) DMs ============
      if (Array.isArray(entry.messaging)) {
        for (const m of entry.messaging) {
          if (m?.message?.is_echo) continue;
          if (!m.message) continue;

          const senderId = m.sender?.id;
          if (!senderId) continue;

          const mid = m.message?.mid;
          if (mid && seenMid(mid)) continue;

          const text = typeof m.message?.text === "string" ? m.message.text : "";
          const hasAttachments = Array.isArray(m.message?.attachments) && m.message.attachments.length > 0;
          if (!text && !hasAttachments) continue;

          const ts = m.timestamp || m.message?.timestamp || entry.time || Date.now();
          const eventKey = `${objectType || "unknown"}|${senderId}|${ts}|${(text || "").slice(0, 32)}`;
          if (seenEventKey(eventKey)) continue;

          await withUserLock(senderId, async () => {
            const category = classify(text);

            if (category === "emergency" || category === "pricing" || category === "sales") {
              const reply = buildAutoReply(category);

              try {
                if (objectType === "instagram") await replyToIGDM(senderId, reply);
                else await replyToFBPageDM(senderId, reply);
              } catch (e) {
                console.error("DM_REPLY_FAIL", String(e));
              }

              await sendRoutingEmail({
                category,
                source: objectType === "instagram" ? "IG_DM" : "FB_DM",
                text: text || "(attachment)",
                meta: { senderId, mid, entryId: entry.id || null },
              });

              return;
            }

            if (shouldShowMenuNow(senderId)) {
              try {
                if (objectType === "instagram") await replyToIGDM(senderId, FAQ_MENU);
                else await replyToFBPageDM(senderId, FAQ_MENU);
                markMenuShown(senderId);
              } catch (e) {
                console.error("MENU_SEND_FAIL", String(e));
              }
              return;
            }

            const option = parseMenuSelection(text);
            if (option) {
              const reply = buildFaqReply(option);
              try {
                if (objectType === "instagram") await replyToIGDM(senderId, reply);
                else await replyToFBPageDM(senderId, reply);
              } catch (e) {
                console.error("FAQ_REPLY_FAIL", String(e));
              }
              return;
            }

            const nudge = "¿Cuál opción eliges (1–5)? Si prefieres, dime tu pregunta y tu *ciudad y sector* 😊";
            try {
              if (objectType === "instagram") await replyToIGDM(senderId, nudge);
              else await replyToFBPageDM(senderId, nudge);
            } catch (e) {
              console.error("NUDGE_FAIL", String(e));
            }
          });
        }
      }

      // ============ B) COMMENTS ============
      if (Array.isArray(entry.changes)) {
        for (const c of entry.changes) {
          const field = c.field;
          const value = c.value || {};

          if (field === "comments" || field === "live_comments") {
            const text = value.text || "";
            const commentId = value.id;
            const from = value.from?.username || value.from?.id || "unknown";
            if (!commentId) continue;

            // Dedupe básico
            const commentKey = `comment|${commentId}|${(text || "").slice(0, 32)}`;
            if (seenEventKey(commentKey)) continue;

            const category = classify(text);

            // 1) LIKE:
            // - General: sí
            // - Pricing/Sales: sí
            // - Emergency: NO
            try {
              if (category !== "emergency") {
                await likeComment(commentId);
                console.log("COMMENT_LIKED", { commentId, category });
              } else {
                console.log("COMMENT_NO_LIKE_EMERGENCY", { commentId });
              }
            } catch (e) {
              console.error("COMMENT_LIKE_FAIL", String(e));
            }

            // 2) RESPUESTA:
            try {
              if (category === "general") {
                await replyToComment(commentId, "🐶❤️");
                console.log("COMMENT_REPLIED_GENERAL", { commentId });
              } else {
                await replyToComment(commentId, buildCommentToDM(category));
                console.log("COMMENT_REPLIED_TO_DM", { commentId, category });

                // Email interno (pricing/sales/emergency)
                await sendRoutingEmail({
                  category,
                  source: "COMMENT",
                  text,
                  meta: { commentId, from, field, category },
                });
              }
            } catch (e) {
              console.error("COMMENT_REPLY_FAIL", String(e));
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
