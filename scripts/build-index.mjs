// Gera o ÍNDICE DE BUSCA estático a partir do conteúdo do site (mesmas fontes
// da KB): páginas de tratamento + posts do blog. Cada item tem título, url,
// resumo e palavras-chave (sintomas/sinônimos curados), para a busca inteligente.
// Escreve dois arquivos, regerados a cada build:
//   - api/_index.generated.js  → consumido pela função serverless (/api/buscar)
//   - public/search-index.json → consumido pelo client (fallback por palavra-chave)
// Roda no `prebuild` (antes do `astro build`) e no servidor de dev.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function decode(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

// Palavras-chave / sintomas em linguagem natural por item (id = nome do arquivo).
const KEYWORDS = {
  // tratamentos
  implantes: [
    "perdi um dente", "perdi dentes", "falta de dente", "dente faltando",
    "dente quebrado", "extraí um dente", "dentadura", "prótese fixa",
    "protocolo", "implante", "recuperar o dente", "voltar a mastigar", "arcada",
  ],
  "protese-dentaria": [
    "prótese", "dentadura", "ponte", "coroa", "dente faltando", "reabilitação",
    "substituir dentes", "prótese removível", "prótese fixa",
  ],
  ortodontia: [
    "dentes tortos", "dentes desalinhados", "alinhar os dentes", "aparelho",
    "mordida errada", "dentes apinhados", "espaço entre os dentes",
  ],
  "alinhadores-invisiveis": [
    "aparelho transparente", "alinhador", "invisalign", "alinhar sem aparelho",
    "dentes tortos", "discreto", "aparelho invisível",
  ],
  endodontia: [
    "tratamento de canal", "canal", "dor de dente", "dente latejando",
    "dente doendo", "cárie profunda", "abscesso", "nervo do dente",
    "infecção no dente",
  ],
  periodontia: [
    "gengiva sangrando", "gengivite", "periodontite", "tártaro",
    "gengiva inflamada", "gengiva retraída", "mau hálito", "dente mole",
  ],
  "harmonizacao-facial": [
    "harmonização facial", "estética do rosto", "preenchimento", "botox",
    "rejuvenescimento", "contorno facial", "linhas de expressão",
  ],
  "facetas-e-lentes": [
    "dentes amarelados", "dentes manchados", "clarear os dentes", "estética",
    "sorriso bonito", "lentes de contato dental", "facetas", "dente lascado",
    "harmonizar o sorriso", "design do sorriso",
  ],
  "odontologia-digital": [
    "escaneamento", "tecnologia", "planejamento 3d", "sem moldagem",
    "odontologia digital", "precisão", "prévia do sorriso",
  ],
  "dentistica-restauradora": [
    "restauração", "cárie", "dente quebrado", "resina", "clareamento",
    "dente lascado", "restaurar dente", "dente escurecido",
  ],
  // artigos
  "implante-dentario": [
    "implante", "perdi um dente", "etapas do implante", "osseointegração",
    "como funciona o implante",
  ],
  "alinhadores-invisiveis-blog": [],
  "protese-protocolo-dentadura": [
    "protocolo", "dentadura", "dentes fixos", "all-on-4", "prótese fixa",
    "troca de dentadura",
  ],
};
// o post do blog tem o mesmo id do tratamento ("alinhadores-invisiveis"); resolve abaixo
const BLOG_KEYWORDS = {
  "alinhadores-invisiveis": [
    "alinhadores invisíveis", "como funcionam", "aparelho transparente",
    "ortodontia discreta", "invisalign",
  ],
};

// --- Páginas de tratamento (src/pages/tratamentos/*.astro) ---
function readTreatments() {
  const dir = join(ROOT, "src/pages/tratamentos");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".astro"))) {
    const id = file.replace(/\.astro$/, "");
    const raw = readFileSync(join(dir, file), "utf8");
    const titleM = raw.match(/title="([^"]+)"/);
    const subM = raw.match(/art-sub">([^<]+)</);
    const titulo = titleM
      ? decode(titleM[1]).replace(/\s*[—-]\s*GOP Implantes\s*$/i, "").trim()
      : id;
    out.push({
      id,
      tipo: "tratamento",
      titulo,
      url: `/tratamentos/${id}.html`,
      resumo: subM ? decode(subM[1]).trim() : "",
      keywords: KEYWORDS[id] || [],
    });
  }
  return out;
}

// --- Posts do blog (src/content/blog/*.md) ---
function readBlog() {
  const dir = join(ROOT, "src/content/blog");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const id = file.replace(/\.md$/, "");
    const raw = readFileSync(join(dir, file), "utf8");
    const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [, ""])[1];
    const get = (k) => {
      const m = fm.match(new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, "m"));
      return m ? m[1].trim() : "";
    };
    out.push({
      id: `blog-${id}`,
      tipo: "artigo",
      titulo: get("title"),
      url: `/blog/${id}.html`,
      resumo: get("description"),
      keywords: BLOG_KEYWORDS[id] || KEYWORDS[id] || [],
    });
  }
  return out;
}

export function buildIndex() {
  const items = [...readTreatments(), ...readBlog()];

  const apiFile = join(ROOT, "api/_index.generated.js");
  const banner =
    "// ARQUIVO GERADO AUTOMATICAMENTE por scripts/build-index.mjs — não edite à mão.\n";
  writeFileSync(apiFile, `${banner}export const INDEX = ${JSON.stringify(items)};\n`);

  const pubDir = join(ROOT, "public");
  if (!existsSync(pubDir)) mkdirSync(pubDir, { recursive: true });
  const pubFile = join(pubDir, "search-index.json");
  writeFileSync(pubFile, JSON.stringify(items));

  return { items: items.length, apiFile, pubFile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = buildIndex();
  console.log(`[build-index] ${r.items} itens -> ${r.apiFile} + ${r.pubFile}`);
}
