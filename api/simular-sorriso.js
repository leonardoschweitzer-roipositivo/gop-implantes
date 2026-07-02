// Função serverless da Vercel (Node) do Simulador de Sorriso com IA. Um único
// endpoint com duas ações: {action:"gerar"} gera a imagem "com implante";
// {action:"lead"} valida nome+WhatsApp+consentimento e envia por e-mail (Resend).
// Segredos (GEMINI_API_KEY / RESEND_API_KEY) ficam só aqui, no servidor.
import {
  readJson,
  rateLimitGerar,
  rateLimitLead,
  handleGerar,
  validateLead,
  handleLead,
} from "./_simular-sorriso-core.mjs";

// Geração de imagem é lenta — sobe o limite do default (10s) da Vercel.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  let body = req.body;
  if (body === undefined || typeof body === "string") body = await readJson(req);

  const action = body?.action;

  if (action === "gerar") {
    if (!rateLimitGerar(ip)) {
      res.statusCode = 429;
      return res.end(
        JSON.stringify({
          ok: false,
          code: "rate",
          error: "Muitas simulações em pouco tempo. Aguarde alguns minutos e tente de novo.",
        })
      );
    }
    const out = await handleGerar(body);
    res.statusCode = out.ok ? 200 : out.status || 400;
    return res.end(
      JSON.stringify(out.ok ? { ok: true, image: out.image } : { ok: false, code: out.code, error: out.error })
    );
  }

  if (action === "lead") {
    if (!rateLimitLead(ip)) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ ok: false, error: "Muitos envios em pouco tempo." }));
    }
    const v = validateLead(body);
    if (!v.ok) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: v.error }));
    }
    if (!v.bot && v.data) await handleLead(v.data);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  }

  res.statusCode = 400;
  return res.end(JSON.stringify({ ok: false, error: "Ação inválida." }));
}
