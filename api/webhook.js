// /api/webhook.js
import nodemailer from "nodemailer";

const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";
const IG_ACCESS_TOKEN = process.env.IG_ACCESS_TOKEN; // token de IG/Graph

// Email env
const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || "gmail";
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const EMAIL_TO_DEFAULT = process.env.EMAIL_TO_DEFAULT;

// Opcionales: si luego quieres separar correos por área
const EMAIL_TO_SALES = process.env.EMAIL_TO_SALES || EMAIL_TO_DEFAULT;
const EMAIL_TO_PRICING = process.env.EMAIL_TO_PRICING || EMAIL_TO_DEFAULT;
const EMAIL_TO_EMERGENCY = process.env.EMAIL_TO_EMERGENCY || EMAIL_TO_DEFAULT;

// --- Keywords (ajústalas a tu negocio) ---
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
  "diarrea",
  "alergia",
  "sangre",
  "convulsión",
  "convulsion",
  "grave",
];

function includesAny(text = "", list = []) {
  const t = text.toLowerCase();
  return list.some((k) => t.includes(k));
}

function classify(text = "") {
  if (includesAny(text, KW_EMERGENCY)) return "emergency";
  if (includesAny(text, KW_PRICING)) return "pricing";
  if (includesAny(text, KW_SALES)) return "sales";
  return "general";
}

function autoReplyFor(type) {
  switch (type) {
    case "pricing":
      return "¡Hola! Para ayudarte con precios, cuéntanos qué producto te interesa y tu ciudad. Te respondemos en breve ✅";
    case "sales":
      return "¡Hola! Para ventas/pedidos, dinos el producto y cantidad. Un asesor te escribe enseguida ✅";
    case "emergency":
      return "Lo siento mucho 🙏 Si es una emergencia, recomendamos contactar a tu veterinario de inmediato. Si nos dejas tu número y ciudad, lo escalamos ahora mismo.";
    default:
      return "¡Hola! Gracias por escribirnos 😊 ¿En qué te podemos ayudar?";
  }
}

// -------- Email --------
async function sendEmail({ to, subject, html }) {
  if (!EMAIL_USER || !EMAIL_PASS || !to) return;

  const transporter = nodemailer.createTransport({
    service: EMAIL_PROVIDER === "gmail" ? "gmail" : undefined,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });

  await transporter.sendMail({
    from: EMAIL_FROM,
    to,
    subject,
    html,
  });
}

// -------- Graph API helpers --------
async function graphPost(path, params) {
  if (!IG_ACCESS_TOKEN) throw new Error("Missing IG_ACCESS_TOKEN");

  const url = new URL(`https://graph.facebook.com/v24.0/${path}`);
  Object.entries({ ...params, access_token: IG_ACCESS_TOKEN }).forEach(
    ([k, v]) => url.searchParams.set(k, String(v))
  );

  const r = await fetch(url.toString(), { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

// Responder DM (Instagram Messaging API)
async function replyDM({ igBusinessId, recipientId, text }) {
  // endpoint: /{ig-user-id}/messages
  return graphPost(`${igBusinessId}/messages`, {
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text }),
  });
}

// Responder comentario (reply público)
async function replyComment({ commentId, text }) {
  // endpoint: /{comment-id}/replies
  return graphPost(`${commentId}/replies`, { message: text });
}

function pickEmailTo(type) {
  if (type === "pricing") return EMAIL_TO_PRICING;
  if (type === "sales") return EMAIL_TO_SALES;
  if (type === "emergency") return EMAIL_TO_EMERGENCY;
  return EMAIL_TO_DEFAULT;
}

// -------- Main handler --------
export default async function handler(req, res) {
  // 1) Verify (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // 2) Events (POST)
  if (req.method === "POST") {
    // Responde rápido a Meta
    res.status(200).json({ ok: true });

    try {
      const body = req.body;

      // A) Mensajes (DMs) estilo "messaging"
      if (Array.isArray(body?.entry)) {
        for (const entry of body.entry) {
          const igBusinessId = entry?.id; // suele ser el IG business id
          const messagingEvents = entry?.messaging || [];

          for (const evt of messagingEvents) {
            const senderId = evt?.sender?.id;
            const recipientId = evt?.recipient?.id;
            const text = evt?.message?.text;

            // Evitar eventos sin texto
            if (!senderId || !recipientId || !text) continue;

            // Evitar auto-responderte a ti mismo (si aplica)
            // si senderId === igBusinessId, es tu cuenta enviando
            if (String(senderId) === String(igBusinessId)) continue;

            const type = classify(text);
            const replyText = autoReplyFor(type);

            // 1) Responder DM
            await replyDM({
              igBusinessId: igBusinessId || recipientId,
              recipientId: senderId,
              text: replyText,
            });

            // 2) Escalar por email (interno)
            const to = pickEmailTo(type);
            await sendEmail({
              to,
              subject: `[Orijen IG] ${type.toUpperCase()} - Nuevo mensaje`,
              html: `
                <h3>Nuevo DM (Instagram)</h3>
                <p><b>Clasificación:</b> ${type}</p>
                <p><b>Sender ID:</b> ${senderId}</p>
                <p><b>Mensaje:</b><br/>${escapeHtml(text)}</p>
                <hr/>
                <p><b>Auto-reply enviado:</b><br/>${escapeHtml(replyText)}</p>
              `,
            });
          }

          // B) Comentarios (changes)
          const changes = entry?.changes || [];
          for (const ch of changes) {
            const field = ch?.field;
            const val = ch?.value;

            // comments / live_comments suelen llegar aquí
            if (!val) continue;

            const commentText = val?.text;
            const commentId = val?.id || val?.comment_id;
            const fromUser = val?.from?.username || val?.from?.name || "unknown";

            if (!commentText || !commentId) continue;

            const type = classify(commentText);
            const replyText = autoReplyFor(type);

            // 1) Responder comentario público
            await replyComment({ commentId, text: replyText });

            // 2) Escalar por email
            const to = pickEmailTo(type);
            await sendEmail({
              to,
              subject: `[Orijen IG] ${type.toUpperCase()} - Nuevo comentario`,
              html: `
                <h3>Nuevo comentario (Instagram)</h3>
                <p><b>Field:</b> ${escapeHtml(String(field))}</p>
                <p><b>Usuario:</b> ${escapeHtml(fromUser)}</p>
                <p><b>Comentario:</b><br/>${escapeHtml(commentText)}</p>
                <hr/>
                <p><b>Reply enviado:</b><br/>${escapeHtml(replyText)}</p>
                <p><b>Comment ID:</b> ${escapeHtml(String(commentId))}</p>
              `,
            });
          }
        }
      }
    } catch (e) {
      console.error("Webhook processing error:", e);
    }

    return;
  }

  return res.status(405).send("Method Not Allowed");
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
