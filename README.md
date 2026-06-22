# GOP Implantes — Site (Astro)

Site institucional da **GOP Implantes** (São Bernardo do Campo — SP).
Construído com **[Astro](https://astro.build)**: gera **HTML estático** (ótimo para SEO e velocidade), com componentes reutilizáveis e blog em Markdown.

> Estrutura e arquitetura derivadas do site da Finkler Odontologia, com a identidade visual da GOP Implantes (azul-marinho/teal, tipografia Poppins + Manrope).

## Rodar localmente

```bash
npm install
npm run dev       # http://localhost:4321 (com hot-reload)
npm run build     # gera o site estático em dist/
npm run preview   # serve o dist/ localmente
```

## Estrutura

```
src/
  pages/
    index.astro                  # home (todas as seções)
    tratamentos/*.astro          # 10 páginas de serviço/tratamento
    blog/[slug].astro            # renderiza cada artigo do blog
  content/
    blog/*.md                    # ARTIGOS DO BLOG (adicione novos .md aqui)
  layouts/BaseLayout.astro       # <head>/SEO, nav, rodapé, WhatsApp, scripts
  components/                    # Nav, Footer, WhatsAppFloat
  styles/global.css              # todo o CSS do site (paleta navy/teal da GOP)
  content.config.ts              # schema da coleção do blog
public/                          # servidos como /...
  favicon.svg  robots.txt  sitemap.xml  images/
astro.config.mjs                 # site + build.format:'file' (URLs .html)
```

URLs com extensão `.html` (ex.: `/tratamentos/implantes.html`, `/blog/implante-dentario.html`) — graças a `build.format: 'file'`. SEO por página: canonical, Open Graph, Twitter, JSON-LD (`Dentist`/`FAQPage`/`BlogPosting`/`Service`/`BreadcrumbList`).

## Identidade visual

- **Cores** (em `src/styles/global.css`, bloco `:root`): `--navy:#1b3a53`, `--navy-deep:#10293c`, `--teal:#2a93b8`, `--sky:#6f97b3`.
- **Fontes:** Poppins (títulos) + Manrope (texto), via Google Fonts no `BaseLayout.astro`.
- **Logo:** wordmark "GOP Implantes" recriado em HTML/CSS (componente `Nav`/`Footer`); o favicon é um "G" em gradiente. Substituir pelo logotipo oficial quando disponível.

## Adicionar um novo artigo no blog

Crie `src/content/blog/meu-artigo.md`:

```md
---
title: "Título do artigo"
description: "Resumo para SEO."
category: "Saúde bucal"
readTime: "5 min de leitura"
date: "2026-06-22"
ctaTitle: "Chamada do CTA final"
ctaText: "Texto do CTA final."
---

Corpo do artigo em **Markdown**. Use ## para subtítulos, listas com -, etc.
```

Vira automaticamente `/blog/meu-artigo.html`, com layout, SEO e JSON-LD prontos.

## Deploy (Vercel)

Projeto Astro: a Vercel detecta o preset **Astro** automaticamente.
- Framework Preset: **Astro**
- Build Command: `astro build` (ou `npm run build`)
- Output Directory: `dist`

## Pendências de conteúdo (placeholders a substituir)

As seções com foto usam **placeholders em gradiente** (com legendas) — as imagens reais entram nestes caminhos:

- **Foto hero** → `public/images/imagem-hero.jpg` (paciente sorrindo). Adicione `onerror` já está pronto: enquanto não houver foto, aparece o card em gradiente.
- **Galeria "Quem somos"** → `public/images/clinica/*.jpg` (recepção, consultórios, etc.).
- **Equipe** → `public/images/equipe.jpg`.
- **Antes & Depois** → `public/images/casos/*` (pares antes/depois).
- **Capas do blog** → `public/images/blog/<slug>.jpg`.
- **Imagem de compartilhamento (Open Graph)** → `public/images/gop-og.jpg` (1200×630).

Outros itens a confirmar com a clínica:
- **WhatsApp/telefone:** hoje `(11) 98514-0604` → `wa.me/5511985140604` (usado em todos os CTAs).
- **Endereço/horário/coordenadas** do mapa e das meta tags `geo.*` (coordenadas atuais são aproximadas do Centro de SBC).
- **Instagram** (`@gopimplantes`) e, se desejar feed embutido, um `feed-id` do Behold para a seção Instagram.
- **E-mail** de contato.
- **Domínio canonical:** `gopimplantes.br` (conectar à Vercel).
