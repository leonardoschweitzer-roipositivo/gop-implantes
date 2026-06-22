// @ts-check
import { defineConfig } from "astro/config";
import { readFileSync, existsSync } from "node:fs";

// Carrega .env.local / .env para process.env (sem dependência de dotenv).
function loadLocalEnv() {
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined)
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
    }
  }
}

// Plugin SÓ DE DESENVOLVIMENTO: faz o `astro dev` (npm run dev) servir POST /api/chat,
// usando o mesmo núcleo da função serverless de produção. Não altera o build estático
// nem o modo de renderização — em produção, quem serve /api/chat é a função da Vercel.
function chatDevPlugin() {
  return {
    name: "gop-chat-dev",
    apply: "serve",
    async configureServer(server) {
      loadLocalEnv();
      if (!process.env.GEMINI_API_KEY) {
        console.warn(
          "\n⚠️  [chat] GEMINI_API_KEY não encontrada. Crie um .env.local com GEMINI_API_KEY=sua_chave\n"
        );
      }
      const { buildKb } = await import("./scripts/build-kb.mjs");
      const kb = buildKb(); // gera api/_kb.generated.js antes de importar o núcleo
      console.log(`[chat] KB pronta: ${kb.sections} seções, ${kb.chars} caracteres`);
      const core = await import("./api/_chat-core.mjs");

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith("/api/chat")) return next();
        if (req.method !== "POST") {
          res.statusCode = 405;
          return res.end("Method Not Allowed");
        }
        if (!core.rateLimit(req.socket.remoteAddress || "local")) {
          res.statusCode = 429;
          return res.end("Muitas mensagens. Aguarde um instante.");
        }
        const body = await core.readJson(req);
        const v = core.validate(body);
        if (!v.ok) {
          res.statusCode = 400;
          return res.end(v.error);
        }
        return core.respond(v.messages, res);
      });
    },
  };
}

// https://astro.build
export default defineConfig({
  site: "https://gopimplantes.br",
  // emite "pagina.html" em vez de "pagina/index.html" — URLs com extensão .html
  build: { format: "file" },
  vite: { plugins: [chatDevPlugin()] },
});
