const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "orijen_rd_verify_2025";

export default async function handler(req, res) {
  // Verificación del webhook (Meta)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // Recepción de eventos (mensajes, etc.)
  if (req.method === "POST") {
    console.log("📩 Webhook recibido:", JSON.stringify(req.body, null, 2));
    return res.status(200).json({ ok: true });
  }

  return res.status(405).send("Method Not Allowed");
}
