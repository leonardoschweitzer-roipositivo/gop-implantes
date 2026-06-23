// Função serverless da Vercel (Node) para a busca inteligente "encontre seu
// tratamento". Mesmo padrão de api/chat.js: a GEMINI_API_KEY fica só no servidor.
// Responde JSON. Se a IA falhar, devolve 502 e o client cai na busca local.
import { validateQuery, rateLimit, readJson, search } from "./_search-core.mjs";

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
    return res.end(JSON.stringify({ ok: false, error: "rate" }));
  }

  let body = req.body;
  if (body === undefined || typeof body === "string") body = await readJson(req);

  const v = validateQuery(body);
  if (!v.ok) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, error: v.error }));
  }

  try {
    const result = await search(v.query);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.end(JSON.stringify({ ok: true, ...result }));
  } catch (e) {
    console.error("[buscar]", e?.message || e);
    res.statusCode = 502;
    return res.end(JSON.stringify({ ok: false, error: "ia_indisponivel" }));
  }
}
