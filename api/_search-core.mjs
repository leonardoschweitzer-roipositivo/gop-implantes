// Núcleo da BUSCA INTELIGENTE ("encontre seu tratamento"). Interpreta o texto
// livre do visitante com o Gemini (saída JSON estruturada) e ranqueia itens do
// índice estático (tratamentos + artigos). Stateless, zero dependências, mesmo
// padrão da função de chat — mas SEM tocar nela. Reaproveita o índice do build.
import { INDEX } from "./_index.generated.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ---- Limites anti-abuso (endpoint público, sem auth) — mesmo padrão do chat ----
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_MAX = 40;
const hits = new Map();
export function rateLimit(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RL_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return true;
  }
  rec.count += 1;
  return rec.count <= RL_MAX;
}

export function readJson(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export function validateQuery(body) {
  if (!body || typeof body.query !== "string")
    return { ok: false, error: "Formato inválido." };
  const query = body.query.replace(/\s+/g, " ").trim().slice(0, 400);
  if (query.length < 2) return { ok: false, error: "Descreva o que você sente." };
  return { ok: true, query };
}

function catalog() {
  return INDEX.map(
    (it) =>
      `- id:${it.id} | ${it.tipo} | ${it.titulo} — ${it.resumo}` +
      (it.keywords?.length ? ` [casos: ${it.keywords.join("; ")}]` : "")
  ).join("\n");
}

const SYSTEM = `Você ajuda visitantes do site da GOP Implantes (clínica odontológica em São Bernardo do Campo - SP) a encontrar o tratamento certo a partir do que eles descrevem em linguagem natural.
- Escolha SOMENTE entre os itens do catálogo fornecido; use exatamente os "id" listados. Nunca invente itens nem ids.
- Priorize tratamentos como recomendação principal; artigos do blog entram como conteúdo de apoio.
- Os "motivos" devem ser curtos (1 frase), em português do Brasil, com tom acolhedor, sem prometer resultados nem dar diagnóstico.
- Se a descrição não tiver relação com odontologia, devolva itens vazios e uma mensagem gentil.`;

async function rankWithAI(query) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY ausente no ambiente");

  const schema = {
    type: "object",
    properties: {
      recomendado: {
        type: "object",
        properties: { id: { type: "string" }, motivo: { type: "string" } },
      },
      itens: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, motivo: { type: "string" } },
          required: ["id", "motivo"],
        },
      },
      mensagem: { type: "string" },
    },
    required: ["itens", "mensagem"],
  };

  const prompt = `Catálogo (use somente estes ids):\n${catalog()}\n\nDescrição do visitante: "${query}"\n\nRetorne: o tratamento recomendado (recomendado) e até 4 itens relevantes (itens), do mais ao menos relevante, cada um com um motivo curto e acolhedor; e uma "mensagem" curta de 1 frase apresentando o resultado.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  // Timeout no lado do servidor: se o Gemini demorar/travar, falhamos rápido
  // (em vez de pendurar a função) para o client cair logo no fallback local.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: schema,
          maxOutputTokens: 1536,
          // tarefa estruturada e objetiva: sem "pensamento" (senão consome o
          // orçamento de tokens e a resposta JSON volta vazia/truncada).
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return JSON.parse(text);
}

function hydrate(parsed) {
  const byId = new Map(INDEX.map((it) => [it.id, it]));
  const toCard = (it, motivo) => ({
    id: it.id,
    tipo: it.tipo,
    titulo: it.titulo,
    url: it.url,
    resumo: it.resumo,
    motivo: (motivo || "").trim() || it.resumo,
  });

  const seen = new Set();
  const itens = [];
  for (const x of parsed?.itens || []) {
    const it = byId.get(x?.id);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    itens.push(toCard(it, x.motivo));
  }

  let recomendado = null;
  const recIt = parsed?.recomendado?.id ? byId.get(parsed.recomendado.id) : null;
  if (recIt) recomendado = toCard(recIt, parsed.recomendado.motivo);
  else if (itens.length) recomendado = itens[0];

  const lista = recomendado ? itens.filter((i) => i.id !== recomendado.id) : itens;
  return { recomendado, itens: lista, mensagem: (parsed?.mensagem || "").trim() };
}

// Orquestra: IA -> hidratação, com 1 retry para absorver falhas transitórias
// (resposta vazia/truncada sob pico). Se as duas tentativas falharem, lança o
// erro e o handler devolve 502 -> o client cai na busca por palavra-chave.
export async function search(query) {
  try {
    return hydrate(await rankWithAI(query));
  } catch (e) {
    return hydrate(await rankWithAI(query));
  }
}
