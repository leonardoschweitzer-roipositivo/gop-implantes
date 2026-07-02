// Núcleo do "Simulador de Sorriso com IA". Duas ações:
//   - gerar: recebe uma foto (dataURL), faz um pré-check barato (Gemini flash) e
//     gera a versão "com implante" preservando as feições (Gemini flash image).
//   - lead: valida nome+WhatsApp+consentimento e envia o lead (com a foto
//     antes/depois em anexo) à clínica por e-mail (Resend).
// Compartilhado entre a função serverless da Vercel (api/simular-sorriso.js) e o
// plugin de dev do astro.config.mjs. Zero dependências — usa fetch nativo.

const VISION_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const WPP = "(11) 98514-0604";
const TO = process.env.SIMULADOR_TO_EMAIL || process.env.AGENDA_TO_EMAIL || "contato@gopimplantes.br";
const FROM = process.env.AGENDA_FROM || "Site GOP Implantes <site@gopimplantes.br>";

// Tamanho máximo do dataURL recebido (o front já reduz p/ ~1280px + JPEG).
const MAX_IMG_BYTES = 6 * 1024 * 1024;

// ---- Rate-limit simples em memória, por ação (best-effort; geração é cara) ----
const RL_WINDOW_MS = 30 * 60 * 1000;
function makeLimiter(max) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.start > RL_WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return true;
    }
    rec.count += 1;
    return rec.count <= max;
  };
}
export const rateLimitGerar = makeLimiter(5); // gerações por IP por janela
export const rateLimitLead = makeLimiter(12); // leads por IP por janela

// ---- Utilidades ----
const clean = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const IMG_RE = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

// Extrai {mimeType, b64} de um dataURL de imagem. Lança "img_invalida"/"img_grande".
function parseImage(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("img_invalida");
  if (dataUrl.length > MAX_IMG_BYTES) throw new Error("img_grande");
  const m = IMG_RE.exec(dataUrl);
  if (!m) throw new Error("img_invalida");
  const b64 = m[2];
  if (b64.length * 0.75 > MAX_IMG_BYTES) throw new Error("img_grande");
  return { mimeType: m[1] === "image/jpg" ? "image/jpeg" : m[1], b64 };
}
function imgOrNull(dataUrl) {
  try {
    return parseImage(dataUrl);
  } catch {
    return null;
  }
}

// ============================ PRÉ-CHECK (barato) ============================
// Filtra fotos ruins/impróprias ANTES de gastar no modelo de imagem, e permite
// dar um retorno amigável. Fail-open: se o pré-check falhar tecnicamente, segue
// para a geração (o modelo de imagem tem os filtros de segurança do Google).
const PRECHECK_SYSTEM = `Você analisa uma foto enviada para um simulador de sorriso odontológico. Responda SOMENTE o JSON pedido. Avalie se é uma foto de rosto humano real, de frente ou quase de frente, com a boca sorrindo e os dentes visíveis, adequada para simular a colocação de implantes dentários. Marque "usable": false se: não for um rosto humano real; for conteúdo impróprio, ofensivo ou de menor de idade em contexto inadequado; o rosto estiver muito de lado ou cortado; os olhos/boca não estiverem visíveis; a boca estiver fechada ou sem dentes à mostra; a imagem estiver muito escura, clara ou borrada. Em "reason", escreva 1 frase curta em português explicando o principal problema (ou "ok" se estiver boa).`;

const PRECHECK_SCHEMA = {
  type: "OBJECT",
  properties: {
    usable: { type: "BOOLEAN" },
    isFace: { type: "BOOLEAN" },
    smiling: { type: "BOOLEAN" },
    teethVisible: { type: "BOOLEAN" },
    reason: { type: "STRING" },
  },
  required: ["usable", "isFace", "smiling", "teethVisible", "reason"],
};

async function precheck(mimeType, b64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PRECHECK_SYSTEM }] },
        contents: [
          { role: "user", parts: [{ inlineData: { mimeType, data: b64 } }, { text: "Avalie esta foto." }] },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: PRECHECK_SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!resp.ok) return { usable: true, reason: "" }; // fail-open
    const json = await resp.json();
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "{}";
    return JSON.parse(text);
  } catch {
    return { usable: true, reason: "" }; // fail-open
  } finally {
    clearTimeout(timer);
  }
}

function friendlyReason(pc) {
  if (pc && pc.isFace === false)
    return "Não identifiquei um rosto na foto. Envie uma selfie de frente, sorrindo e mostrando os dentes.";
  if (pc && (pc.smiling === false || pc.teethVisible === false))
    return "Para simular, preciso de uma foto sorrindo com os dentes à mostra (dá para ver o espaço do dente). Tente de novo com um sorriso aberto.";
  return "Essa foto não ficou boa para a simulação. Use uma foto de frente, com boa luz, sorrindo e mostrando os dentes.";
}

// ============================ GERAÇÃO DA IMAGEM ============================
// PROMPT detalhado — a peça central. Hierarquia: preservar identidade > mudar só
// os dentes faltantes > realismo. Em inglês (melhor aderência do modelo).
const SMILE_PROMPT = `You are a specialist dental smile-simulation photo editor. You will receive ONE photograph of a real person smiling with one or more MISSING teeth (empty gaps in the smile). Edit ONLY the teeth region so the photo looks as if those missing teeth had been restored with high-quality dental IMPLANT crowns. Return the edited photograph — nothing else.

# ABSOLUTE IDENTITY PRESERVATION (most important rule)
- Keep the SAME person, unmistakably. Do NOT alter facial features, bone structure, face shape, jawline, chin, nose, philtrum, eyes, eyebrows, cheeks, ears, or hairstyle.
- Keep the SAME age and skin: same tone, texture, pores, freckles, moles, lines and wrinkles. Do NOT smooth, retouch, slim, or beautify the skin or face in any way.
- Keep the SAME head pose, camera angle, framing, crop and subject distance.
- Keep the SAME lighting, shadows, white balance, color grading, depth of field and background. Do NOT relight or recolor the scene.
- Keep the SAME expression and the SAME smile width. Keep the lips' shape, position and color; allow ONLY the minimal, natural change strictly needed for the new teeth to be visible inside the existing smile. Do NOT widen, stretch or reshape the smile or the mouth.
- Preserve the person's EXISTING teeth exactly: their shape, length, spacing, edges and color.

# WHAT TO CHANGE — and nothing else
- Locate every empty gap where a tooth is missing.
- Fill each gap with a single, anatomically correct replacement tooth (implant crown) for that exact position (central/lateral incisor, canine, premolar, molar), with a natural emergence profile from a healthy, natural-looking gum line with proper papilla.
- MATCH the new teeth to the neighbouring natural teeth: same shade and value (do NOT bleach them bright white — copy the real, slightly warm off-white tone of the adjacent teeth), same translucency at the incisal edge, same size proportion, same alignment following the natural dental arch, same surface texture and wear.

# ULTRA-REALISM REQUIREMENTS
- The result MUST be ultra-photorealistic and indistinguishable from a real, unedited photo of the SAME person. No CGI, cartoon, plastic, glossy or "denture-perfect" look. No uniform, decal teeth. Natural micro-variation between teeth.
- Match the original photo's sharpness, grain/noise, compression and specular highlights so the edited area blends seamlessly with the rest of the mouth and face.
- Do NOT whiten or modify the existing teeth. Do NOT add makeup, jewelry, or change clothing.
- Output ONLY the edited photograph at the SAME resolution and aspect ratio as the input. No text, captions, watermarks, logos, arrows, borders or side-by-side comparison.`;

async function generateImage(mimeType, b64, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 50000); // geração de imagem é lenta
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ inlineData: { mimeType, data: b64 } }, { text: SMILE_PROMPT }] },
        ],
        generationConfig: { responseModalities: ["IMAGE"], temperature: 0.2 },
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
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const img = parts.find((p) => p.inlineData?.data);
  if (!img) throw new Error("sem_imagem_no_retorno");
  const outMime = img.inlineData.mimeType || "image/png";
  return `data:${outMime};base64,${img.inlineData.data}`;
}

// 1 retry para absorver falhas transitórias.
async function generateImageRetry(mimeType, b64, apiKey) {
  try {
    return await generateImage(mimeType, b64, apiKey);
  } catch (e) {
    console.error("[simular] retry após:", e?.message || e);
    return await generateImage(mimeType, b64, apiKey);
  }
}

// Orquestra a ação "gerar". Devolve um resultado normalizado (ok/status/code/...).
export async function handleGerar(body) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return { ok: false, status: 503, code: "nao_configurado", error: "Serviço indisponível no momento." };

  let img;
  try {
    img = parseImage(body?.image);
  } catch (e) {
    const grande = e.message === "img_grande";
    return {
      ok: false,
      status: 400,
      code: e.message,
      error: grande
        ? "A imagem é muito grande. Envie uma foto um pouco menor."
        : "Envie uma imagem válida (JPG, PNG ou WEBP).",
    };
  }

  const pc = await precheck(img.mimeType, img.b64, apiKey);
  if (pc && pc.usable === false)
    return { ok: false, status: 422, code: "foto_inadequada", error: friendlyReason(pc) };

  try {
    const out = await generateImageRetry(img.mimeType, img.b64, apiKey);
    return { ok: true, image: out };
  } catch (e) {
    console.error("[simular gerar]", e?.message || e);
    return {
      ok: false,
      status: 502,
      code: "ia_indisponivel",
      error: `Não consegui gerar a simulação agora. Tente novamente em instantes ou fale conosco no WhatsApp ${WPP}.`,
    };
  }
}

// ============================ LEAD (e-mail) ============================
export function validateLead(body) {
  // honeypot: se preenchido, finge sucesso e não processa (provável bot).
  if (body && (body.fk_hp || body.website)) return { ok: true, bot: true, data: null };

  const nome = clean(body?.nome, 80);
  const whatsapp = clean(body?.whatsapp, 40);
  const consent = body?.consent === true || body?.consent === "true" || body?.consent === "on";

  if (nome.length < 2) return { ok: false, error: "Informe seu nome." };
  if (whatsapp.replace(/\D/g, "").length < 8) return { ok: false, error: "Informe um WhatsApp válido." };
  if (!consent) return { ok: false, error: "É necessário aceitar o consentimento para continuar." };

  return {
    ok: true,
    bot: false,
    data: { nome, whatsapp, depois: imgOrNull(body?.image), antes: imgOrNull(body?.imageOriginal) },
  };
}

function clinicaText(d) {
  return [
    "Novo lead do SIMULADOR DE SORRISO — site GOP Implantes",
    "",
    `Nome: ${d.nome}`,
    `WhatsApp: ${d.whatsapp}`,
    "",
    "Origem: simulador de implante (IA). Lead de ALTA intenção — a pessoa enviou a própria foto para ver o resultado com o dente reposto.",
    "Em anexo: a foto enviada (antes) e a simulação gerada (depois).",
    "Ação sugerida: chamar no WhatsApp e convidar para uma avaliação.",
  ].join("\n");
}

async function sendEmail({ to, subject, text, attachments }) {
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject,
        text,
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
    });
    if (!r.ok) {
      const b = await r.text().catch(() => "");
      console.error(`[simular] Resend ${r.status}: ${b.slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[simular] erro Resend:", e?.message || e);
    return false;
  }
}

// Envia o lead por e-mail para a CLÍNICA (nome + WhatsApp + fotos antes/depois).
// Sem RESEND_API_KEY, só loga — a UX no front continua de sucesso.
export async function handleLead(d) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[simular] lead (sem RESEND_API_KEY): ${d.nome} / ${d.whatsapp}`);
    return;
  }

  const attClinica = [];
  if (d.antes) attClinica.push({ filename: "antes.jpg", content: d.antes.b64 });
  if (d.depois) attClinica.push({ filename: "depois.png", content: d.depois.b64 });
  await sendEmail({
    to: TO,
    subject: `Simulador de sorriso: ${d.nome}`,
    text: clinicaText(d),
    attachments: attClinica,
  });
}

// Lê o corpo JSON de um req do Node quando o framework não o parseou.
export function readJson(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
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

export const WPP_DISPLAY = WPP;
