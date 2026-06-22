// Função serverless da Vercel (Node). O Vercel publica a pasta /api da raiz
// automaticamente, mesmo com o site Astro 100% estático. A chave do Gemini fica
// só aqui, no servidor (env var GEMINI_API_KEY), nunca no navegador.
import { validate, respond, rateLimit, readJson } from "./_chat-core.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  if (!rateLimit(ip)) {
    res.statusCode = 429;
    return res.end("Muitas mensagens em pouco tempo. Aguarde um instante.");
  }

  let body = req.body;
  if (body === undefined || typeof body === "string") body = await readJson(req);

  const v = validate(body);
  if (!v.ok) {
    res.statusCode = 400;
    return res.end(v.error);
  }

  await respond(v.messages, res);
}
