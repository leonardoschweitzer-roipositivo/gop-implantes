// Gera a base de conhecimento (KB) do chat a partir do próprio conteúdo do site.
// Lê as páginas de serviço + posts do blog + fatos da clínica e grava
// `api/_kb.generated.js`. Roda no `prebuild` (antes do `astro build`) e no
// servidor de dev — assim o que a IA "sabe" nunca sai de sincronia com o site.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

function stripHtml(s) {
  return decode(
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// --- Páginas de serviço (src/pages/tratamentos/*.astro) ---
function readTreatments() {
  const dir = join(ROOT, "src/pages/tratamentos");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".astro"))) {
    const raw = readFileSync(join(dir, file), "utf8");
    // remove o frontmatter (--- ... ---) e a CTA repetitiva do fim
    const body = raw.replace(/^---[\s\S]*?---/, "");
    const titleMatch = raw.match(/title="([^"]+)"/);
    const title = titleMatch
      ? decode(titleMatch[1]).replace(/\s*[—-]\s*GOP Implantes\s*$/i, "")
      : file.replace(/\.astro$/, "");
    const text = stripHtml(body)
      .replace(/^←?\s*Voltar para Serviços\s*/i, "")
      .replace(/\s*Falar no WhatsApp\s*$/i, "")
      .trim();
    out.push(`### ${title}\n${text}`);
  }
  return out;
}

// --- Posts do blog (src/content/blog/*.md) ---
function readBlog() {
  const dir = join(ROOT, "src/content/blog");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = readFileSync(join(dir, file), "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const fm = fmMatch ? fmMatch[1] : "";
    const titleMatch = fm.match(/title:\s*"?([^"\n]+)"?/);
    const title = titleMatch ? titleMatch[1].trim() : file;
    let body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    body = stripHtml(body) // tira <div class="callout"> etc.
      .replace(/[#>*_`]+/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    out.push(`### ${title}\n${body}`);
  }
  return out;
}

// --- Página inicial (src/pages/index.astro) — texto visível das seções ---
// Captura FAQ, diferenciais, "quem somos", benefícios, depoimentos, etc.
// stripHtml já remove <script> (JSON-LD/seletor), <style> e <svg>.
function readHome() {
  const file = join(ROOT, "src/pages/index.astro");
  if (!existsSync(file)) return [];
  const body = readFileSync(file, "utf8").replace(/^---[\s\S]*?---/, "");
  const text = stripHtml(body)
    .replace(/Saiba mais →|Ler artigo →|Arraste para o lado[^\n]*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return text ? [`### Conteúdo da página inicial (seções do site)\n${text}`] : [];
}

const CLINIC = `### Sobre a GOP Implantes
A GOP Implantes é uma clínica odontológica em São Bernardo do Campo (SP), com mais de 40 anos de experiência no mesmo local. Atende de forma personalizada e humanizada, com profissionais qualificados e tecnologia atual, em diversas áreas da odontologia. Atende toda a família.

Áreas e tratamentos: Implantes dentários e protocolo, Prótese dentária, Ortodontia, Endodontia (tratamento de canal), Periodontia, Alinhadores invisíveis, Harmonização facial, Facetas e lentes dentais, Odontologia digital e Dentística restauradora.

Contato e localização:
- Endereço: R. Jurubatuba, 845 — Térreo, Centro — São Bernardo do Campo, SP.
- WhatsApp (canal preferido para agendar): (11) 98514-0604 — link https://wa.me/5511985140604
- Instagram: @gopimplantes
- Atendimento com hora marcada.

Avaliação no Google: 4,4 de 5 (44 avaliações).
A clínica oferece preços acessíveis e facilidades de pagamento, mas não divulga tabela de preços no site: os valores são definidos após uma avaliação, conforme o caso de cada paciente. A primeira consulta de avaliação é gratuita.`;

export function buildKb() {
  const parts = [CLINIC, ...readHome(), ...readTreatments(), ...readBlog()];
  const kb = parts.join("\n\n---\n\n").trim();
  const outFile = join(ROOT, "api/_kb.generated.js");
  const banner =
    "// ARQUIVO GERADO AUTOMATICAMENTE por scripts/build-kb.mjs — não edite à mão.\n";
  writeFileSync(outFile, `${banner}export const KB = ${JSON.stringify(kb)};\n`);
  return { chars: kb.length, sections: parts.length, outFile };
}

// Executa quando chamado direto (node scripts/build-kb.mjs)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = buildKb();
  console.log(
    `[build-kb] KB gerada: ${r.sections} seções, ${r.chars} caracteres -> ${r.outFile}`
  );
}
