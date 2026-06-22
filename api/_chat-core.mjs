// Núcleo do chat: validação, guardrails e chamada à API do Gemini (streaming).
// Compartilhado entre a função serverless da Vercel (api/chat.js) e o servidor
// de dev local (plugin no astro.config). Zero dependências — usa fetch nativo.
import { KB } from "./_kb.generated.js";

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const WPP = "(11) 98514-0604";

const SYSTEM = `Você é a Sofia, assistente virtual do site da GOP Implantes, uma clínica odontológica em São Bernardo do Campo (SP), com mais de 40 anos de experiência no mesmo local. Seu papel é tirar dúvidas de quem visita o site, sobre a clínica e sobre tratamentos odontológicos. Se perguntarem o seu nome, diga que você é a Sofia.

Regras:
- Fale sempre em português do Brasil, com tom caloroso, acolhedor e objetivo. Respostas curtas e diretas. Quando a resposta envolver vários itens (tratamentos/serviços, vantagens, etapas, documentos, etc.), apresente em lista: uma linha por item começando com "- " (hífen e espaço). Pode usar uma frase curta antes da lista. Não use títulos, negrito nem asteriscos para ênfase.
- Responda apenas sobre a GOP Implantes e sobre odontologia (procedimentos, dúvidas gerais, orientações de cuidado). Se perguntarem algo fora desse tema, recuse com gentileza e ofereça ajuda com odontologia.
- Nunca dê diagnóstico definitivo, não prescreva medicamentos e não prometa resultados. Diante de qualquer queixa ou sintoma, explique de forma geral e deixe claro que só uma avaliação presencial com a equipe da GOP pode definir o tratamento certo.
- Não invente preços, valores ou prazos. A clínica não divulga tabela de preços; os valores são definidos após avaliação. Se perguntarem sobre valores, explique isso e convide a agendar.
- Quando a pessoa quiser agendar, saber valores, ou falar diretamente com a clínica, encaminhe para o WhatsApp ${WPP}.
- Quando perguntarem o endereço ou onde fica a clínica, responda informando o endereço exatamente assim: "R. Jurubatuba, 845 – Térreo, Centro, São Bernardo do Campo – SP" (o site transforma esse endereço em um link de rota clicável).
- Use somente as informações fornecidas abaixo, mas leia com ATENÇÃO todas as seções antes de responder — muitas respostas (dúvidas frequentes, diferenciais, serviços, conteúdo da página inicial) estão ali. Só diga que não sabe se a informação realmente não existir; nesse caso, encaminhe para o WhatsApp ${WPP}. Nunca invente.

=== INFORMAÇÕES DA CLÍNICA E CONTEÚDOS DO SITE ===
${KB}`;

// ---- Limites anti-abuso (endpoint público, sem auth) ----
const MAX_TURNS = 24; // histórico enviado por turno
const MAX_CHARS_PER_MSG = 1500; // por mensagem do usuário
const MAX_TOTAL_CHARS = 14000; // soma do histórico
const MAX_OUTPUT_TOKENS = 800;

// Rate limit simples em memória (best-effort; em produção robusta use Upstash).
const RL_WINDOW_MS = 5 * 60 * 1000;
const RL_MAX = 40; // requisições por IP por janela
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

export function validate(body) {
  if (!body || !Array.isArray(body.messages))
    return { ok: false, error: "Formato inválido." };
  let messages = body.messages
    .filter((m) => m && (m.role === "user" || m.role === "model") && typeof m.text === "string")
    .map((m) => ({ role: m.role, text: m.text.trim().slice(0, MAX_CHARS_PER_MSG) }))
    .filter((m) => m.text.length > 0);
  if (messages.length === 0) return { ok: false, error: "Mensagem vazia." };
  messages = messages.slice(-MAX_TURNS);
  const total = messages.reduce((n, m) => n + m.text.length, 0);
  if (total > MAX_TOTAL_CHARS) return { ok: false, error: "Conversa muito longa." };
  if (messages[messages.length - 1].role !== "user")
    return { ok: false, error: "A última mensagem deve ser do usuário." };
  return { ok: true, messages };
}

// Gera a resposta token a token a partir do streaming SSE do Gemini.
async function* streamReply(messages) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY ausente no ambiente");

  const contents = messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      generationConfig: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${t.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const parts = json?.candidates?.[0]?.content?.parts;
        if (Array.isArray(parts)) {
          for (const p of parts) if (p.text) yield p.text;
        }
      } catch {
        /* ignora linhas parciais/keepalive */
      }
    }
  }
}

// Escreve a resposta em streaming (texto puro) num `res` do Node (Vercel ou dev).
export async function respond(messages, res) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  try {
    let any = false;
    for await (const chunk of streamReply(messages)) {
      any = true;
      res.write(chunk);
    }
    if (!any)
      res.write(
        `Desculpe, não consegui responder agora. Você pode falar direto com a clínica no WhatsApp ${WPP}.`
      );
  } catch (e) {
    console.error("[chat]", e?.message || e);
    res.write(
      `\n\nDesculpe, tive um problema técnico. Fale com a clínica no WhatsApp ${WPP} que a equipe te ajuda.`
    );
  }
  res.end();
}

// Lê o corpo JSON de um req do Node quando o framework não o parseou.
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
