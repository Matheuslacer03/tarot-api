// ============================================================
//  api/reading.js  — backend da IA de tarô (Gemini) — v3 (diagnóstico)
// ------------------------------------------------------------
//  Igual à v2 (thinking desligado), MAIS:
//   - sempre inclui "_v":"v3" na resposta (pra confirmar que o código novo subiu)
//   - se vier vazio, inclui "_debug" com o motivo exato
//
//  VAI EM: api/reading.js   |   VARIÁVEL NA VERCEL: GEMINI_API_KEY
// ============================================================

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

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

const PERSONAS = {
  isis: "Você é a Dona Ísis: calorosa e maternal. Valida os sentimentos da pessoa antes de interpretar. Linguagem simples e afetuosa.",
  rafael: "Você é o Rafael: direto, prático e objetivo, mas gentil. Corta o floreio e sempre termina com uma ação concreta.",
  luna: "Você é a Luna: mística e poética. Fala em imagens e símbolos, mas termina com uma mensagem clara.",
};

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
  const p = PERSONAS[persona] || PERSONAS.isis;
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

function safeParse(text) {
  const clean = String(text).replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return { reading: clean, advice: "", next7days: "" };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed", _v: "v3" });

  try {
    const input =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const mode = input.mode || "short";
    const maxTokens = mode === "full" ? 2048 : 1024;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const body = {
      systemInstruction: {
        parts: [{ text: buildSystem(input.persona || "isis", input.oracle || null, mode) }],
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

    const parsed = safeParse(text);
    parsed._v = "v3"; // etiqueta de versão: se aparecer, o código novo está no ar

    if (!parsed.reading) {
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
    return res.status(500).json({ error: "reading_failed", detail: String((e && e.message) || e), _v: "v3" });
  }
};
