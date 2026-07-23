// ============================================================
//  api/reading.js  — backend da IA de tarô (Gemini) — v5 (endurecido)
// ------------------------------------------------------------
//  Base: v4 (vozes misticista/pragmatico/poeta). Preservado o conteúdo.
//  ADIÇÕES de segurança (auditoria 20/07/2026), todas configuráveis por env:
//   - Rate limiting por IP (Upstash Redis REST; degrada p/ in-memory)
//   - Validação de entrada no servidor (tamanho, tipos, whitelist)
//   - Token de app opcional (header x-app-token vs APP_TOKEN)
//   - CORS por allowlist opcional (ALLOWED_ORIGINS)
//   - Parse robusto da resposta do Gemini (corrige o JSON-cru do dailyCard)
//   - Erros genéricos em produção (_debug/detail só com DEBUG=1)
//
//  VAI EM: api/reading.js
//  ENV OBRIGATÓRIAS: GEMINI_API_KEY | GEMINI_MODEL = gemini-3.5-flash
//  ENV OPCIONAIS: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//                 RATE_LIMIT_MAX (20), RATE_LIMIT_WINDOW_S (60),
//                 APP_TOKEN, ALLOWED_ORIGINS (csv), DEBUG (1)
// ============================================================

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const DEBUG = process.env.DEBUG === "1";

// ---- limites de validação ----
const LIMITS = {
  question: 600, // o app limita a 200; folga p/ não rejeitar usuário legítimo
  cardName: 60,
  cards: 6,
  keyword: 40,
  keywords: 8,
  shortField: 40, // readingType / persona / oracle
};
const MODES = ["short", "full", "dailyCard"];

const BASE = `Você é um(a) leitor(a) de oráculos experiente e acolhedor(a), fazendo uma leitura personalizada em português do Brasil.

TOM
- Fale de forma calorosa, próxima e humana. Nada de texto genérico que serve pra qualquer um.
- A leitura mostra TENDÊNCIAS e reflexões, nunca um destino fixo. A pessoa sempre tem escolha.
- Conecte a interpretação diretamente à PERGUNTA e às CARTAS sorteadas.

CONTEÚDO
- NUNCA preveja morte, doença grave, tragédias, gravidez ou datas exatas de eventos.
- Não dê conselho médico, jurídico ou financeiro determinístico; oriente com cuidado e sugira um profissional quando for o caso.
- Cartas "difíceis" (A Torre, A Morte, O Diabo) são transformação/aprendizado, não catástrofe. Não amedronte. Não faça promessas absolutas.

SEGURANÇA (prioridade máxima)
- Se a pergunta indicar sofrimento intenso, desesperança, ideação suicida ou automutilação: NÃO faça leitura de cartas. Responda com acolhimento breve e humano, diga que a pessoa não está sozinha e sugira apoio real — no Brasil, o CVV (ligue 188, 24h, gratuito e sigiloso). Coloque esse acolhimento no campo "reading" e deixe os outros vazios.`;

// ---- As 3 vozes do app ----
const PERSONAS = {
  misticista:
    "Você é o(a) Misticista: espiritual, intuitivo(a) e conectado(a) às energias. Fala do que as cartas revelam no plano sutil, dos símbolos e dos sinais, com uma aura de mistério — mas sempre traduz tudo numa mensagem clara e útil no final.",
  pragmatico:
    "Você é o(a) Pragmático(a): direto(a), prático(a) e pé no chão, mas gentil. Sem floreio: diz o que as cartas indicam de forma objetiva e sempre termina com um passo concreto que a pessoa pode dar.",
  poeta:
    "Você é o(a) Poeta: lírico(a) e sensível. Transforma as cartas em imagens, metáforas e uma pequena narrativa bonita — mas fecha sempre com uma mensagem clara que a pessoa leva pra vida.",
};

// aliases pra aceitar variações (e não quebrar a página de teste antiga)
const ALIASES = {
  mistico: "misticista", mistica: "misticista", misticismo: "misticista", isis: "misticista",
  pragmatica: "pragmatico", pratico: "pragmatico", pratica: "pragmatico", direto: "pragmatico", rafael: "pragmatico",
  poetisa: "poeta", poetico: "poeta", poetica: "poeta", poesia: "poeta", luna: "poeta",
};

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function resolvePersona(key) {
  const k = norm(key);
  if (PERSONAS[k]) return k;
  if (ALIASES[k]) return ALIASES[k];
  return "misticista";
}

const ORACLES = {
  tarot: "Oráculo: Tarô. Interprete cada arcano pelo significado tradicional, considerando se está invertida e a posição na tiragem.",
  buzios: "Oráculo: Búzios / matriz africana. Trate com respeito e reverência, jamais como folclore. Seja humilde quando faltar base e mantenha o foco no acolhimento e na reflexão.",
  cigano: "Oráculo: Baralho Cigano (Lenormand). Mensagens diretas e práticas do cotidiano; combine as cartas em pares.",
  orixas: "Oráculo: Orixás. Fale das forças espirituais com dignidade e respeito à tradição de matriz africana.",
  pombagira: "Oráculo: Pomba Gira / Maria Padilha (Umbanda). Ligada à força feminina, ao amor e ao poder pessoal. Trate com respeito, sem estereótipo. Foco em autoestima, relações e coragem.",
};

function outputInstruction(mode) {
  if (mode === "full") {
    return `Retorne SOMENTE JSON válido, no formato exato:
{"reading":"interpretação carta a carta ligada à pergunta","advice":"um conselho central, prático e empoderador","next7days":"o que observar e como agir nos próximos 7 dias"}`;
  }
  const extra =
    mode === "dailyCard"
      ? "Some uma atitude para as próximas 24h."
      : "Entregue valor real, mas deixe um gancho para o aprofundamento.";
  return `Escreva 2-3 frases. ${extra} Retorne SOMENTE JSON válido, no formato:
{"reading":"...","advice":"","next7days":""}`;
}

function buildSystem(persona, oracle, mode) {
  const p = PERSONAS[resolvePersona(persona)];
  const o = oracle ? ORACLES[oracle] || ORACLES.tarot : ORACLES.tarot;
  return [BASE, p, o, outputInstruction(mode)].join("\n\n");
}

function buildUserMessage(input) {
  const cartas =
    (input.cards || [])
      .map((c) => `${c.name}${c.reversed ? " (invertida)" : ""}`)
      .join(", ") || "—";
  const tipo = input.readingType ? `Tema: ${input.readingType}. ` : "";
  return `${tipo}Pergunta: "${input.question || "(sem pergunta específica)"}"\nCartas sorteadas: ${cartas}`;
}

// ---- validação de entrada (servidor) ----
function validate(input) {
  if (!input || typeof input !== "object") return "corpo inválido";
  const mode = input.mode == null ? "short" : input.mode;
  if (!MODES.includes(mode)) return "mode inválido";
  if (input.question != null) {
    if (typeof input.question !== "string") return "question inválida";
    if (input.question.length > LIMITS.question) return "question muito longa";
  }
  for (const key of ["readingType", "persona", "oracle"]) {
    if (input[key] != null) {
      if (typeof input[key] !== "string") return `${key} inválido`;
      if (input[key].length > LIMITS.shortField) return `${key} muito longo`;
    }
  }
  if (input.cards != null) {
    if (!Array.isArray(input.cards)) return "cards inválido";
    if (input.cards.length > LIMITS.cards) return "cards demais";
    for (const c of input.cards) {
      if (!c || typeof c !== "object") return "carta inválida";
      if (typeof c.name !== "string" || c.name.length > LIMITS.cardName) return "nome de carta inválido";
      if (c.reversed != null && typeof c.reversed !== "boolean") return "reversed inválido";
      if (c.keywords != null) {
        if (!Array.isArray(c.keywords) || c.keywords.length > LIMITS.keywords) return "keywords inválidas";
        for (const k of c.keywords) {
          if (typeof k !== "string" || k.length > LIMITS.keyword) return "keyword inválida";
        }
      }
    }
  }
  return null; // ok
}

// ---- parse robusto: corrige o JSON-cru que às vezes vinha no dailyCard ----
function grabField(text, key) {
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "";
}
function robustParse(text) {
  const clean = String(text).replace(/```json|```/g, "").trim();
  try {
    const p = JSON.parse(clean);
    if (p && typeof p === "object") {
      return {
        reading: typeof p.reading === "string" ? p.reading : "",
        advice: typeof p.advice === "string" ? p.advice : "",
        next7days: typeof p.next7days === "string" ? p.next7days : "",
      };
    }
  } catch {
    // JSON com lixo (ex.: 'za."}' no fim) — extrai só o bloco {...}
    const block = clean.match(/\{[\s\S]*\}/);
    if (block) {
      try {
        const p = JSON.parse(block[0]);
        return {
          reading: typeof p.reading === "string" ? p.reading : "",
          advice: typeof p.advice === "string" ? p.advice : "",
          next7days: typeof p.next7days === "string" ? p.next7days : "",
        };
      } catch {
        // ainda malformado — extrai campo a campo por regex
        const r = grabField(clean, "reading");
        if (r || grabField(clean, "advice")) {
          return { reading: r, advice: grabField(clean, "advice"), next7days: grabField(clean, "next7days") };
        }
      }
    }
  }
  // último recurso: devolve o texto limpo como leitura (não perde conteúdo)
  return { reading: clean, advice: "", next7days: "" };
}

// ---- rate limiting ----
// Retorna { ok, backend, count, note } — backend/note ajudam no diagnóstico (DEBUG).
const memBuckets = new Map(); // fallback in-memory (por instância)
function memRateLimit(ip, max, windowS, note) {
  const now = Date.now();
  const winStart = now - windowS * 1000;
  const hits = (memBuckets.get(ip) || []).filter((t) => t > winStart);
  hits.push(now);
  memBuckets.set(ip, hits);
  if (memBuckets.size > 5000) memBuckets.clear(); // guarda contra vazamento
  return { ok: hits.length <= max, backend: "memory", count: hits.length, note: note || "" };
}
async function upstashRateLimit(ip, max, windowS) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = `rl:${ip}:${Math.floor(Date.now() / (windowS * 1000))}`;
  const r = await fetch(`${base}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify([["INCR", key], ["EXPIRE", key, String(windowS)]]),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error("upstash HTTP " + r.status + " " + body.slice(0, 120));
  }
  const out = await r.json();
  const count = Number((out && out[0] && out[0].result) || 0);
  return { ok: count <= max, backend: "upstash", count, note: "" };
}
async function checkRateLimit(ip) {
  const max = Number(process.env.RATE_LIMIT_MAX || 20);
  const windowS = Number(process.env.RATE_LIMIT_WINDOW_S || 60);
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      return await upstashRateLimit(ip, max, windowS);
    } catch (e) {
      return memRateLimit(ip, max, windowS, "upstash_falhou: " + String(e && e.message || e)); // não derruba a API
    }
  }
  return memRateLimit(ip, max, windowS, "sem_env_upstash");
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.headers["x-real-ip"] || "unknown";
}

// ---- CORS ----
function applyCors(req, res) {
  const allow = (process.env.ALLOWED_ORIGINS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (allow.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*"); // sem allowlist: permissivo (default atual)
  } else if (origin && allow.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  // requisições nativas (app) não mandam Origin — passam pelas checagens de token/rate-limit
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-app-token");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function fail(res, status, error) {
  return res.status(status).json({ error, _v: "v5" });
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");

  // token de app (opcional): só exige se APP_TOKEN estiver configurado
  if (process.env.APP_TOKEN && req.headers["x-app-token"] !== process.env.APP_TOKEN) {
    return fail(res, 401, "unauthorized");
  }

  // rate limiting por IP
  let rl = null;
  try {
    rl = await checkRateLimit(clientIp(req));
    if (rl && !rl.ok) return fail(res, 429, "rate_limited");
  } catch {
    // erro no rate limiter nunca deve bloquear o serviço
  }

  try {
    const input =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const invalid = validate(input);
    if (invalid) {
      const out = { error: DEBUG ? invalid : "invalid_input", _v: "v5" };
      if (DEBUG && rl) out._rl = rl;
      return res.status(400).json(out);
    }

    const mode = input.mode || "short";
    const maxTokens = mode === "full" ? 2048 : 1024;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const body = {
      systemInstruction: {
        parts: [{ text: buildSystem(input.persona || "misticista", input.oracle || null, mode) }],
      },
      contents: [{ role: "user", parts: [{ text: buildUserMessage(input) }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    const cand = data && data.candidates && data.candidates[0];
    const text =
      (cand &&
        cand.content &&
        cand.content.parts &&
        cand.content.parts.map((p) => p.text).join("")) ||
      "";

    const parsed = robustParse(text);
    parsed._v = "v5";
    if (DEBUG && rl) parsed._rl = rl;
    if (!parsed.reading && DEBUG) {
      parsed._debug = {
        finishReason: cand && cand.finishReason,
        blockReason: data && data.promptFeedback && data.promptFeedback.blockReason,
        apiError: data && data.error && (data.error.message || data.error.status),
        rawLen: text.length,
        model: MODEL,
      };
    }
    return res.status(200).json(parsed);
  } catch (e) {
    return res.status(500).json({ error: "reading_failed", _v: "v5", ...(DEBUG ? { detail: String((e && e.message) || e) } : {}) });
  }
};
