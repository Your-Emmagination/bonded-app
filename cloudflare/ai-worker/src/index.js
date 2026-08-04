const DEFAULT_MODEL = "llama-3.1-8b-instant";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_CONTEXT_MESSAGES = 12;
const EXACT_BLOCKLIST = ["shabu", "weed", "marijuana", "vape", "nudes", "porn", "suicide"];
const SUBSTRING_BLOCKLIST = [
  "kill yourself",
  "sex video",
  "bomb",
  "sexual assault",
  "drug dealer",
  "escort",
  "explicit",
];
const MAX_MEMORY_BLOCKS = 12;

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(init.headers?.["Access-Control-Allow-Origin"]),
      ...(init.headers || {}),
    },
  });

function buildCorsHeaders(allowedOrigin = "*") {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function sanitizeContextMessages(contextMessages = []) {
  return contextMessages
    .slice(-MAX_CONTEXT_MESSAGES)
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: `${message.name || "User"}: ${message.content || ""}`.trim(),
    }))
    .filter((message) => message.content);
}

function sanitizeMemoryBlocks(memoryBlocks = []) {
  return memoryBlocks
    .slice(0, MAX_MEMORY_BLOCKS)
    .map((block) => String(block || "").trim())
    .filter(Boolean);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runRuleBasedModeration(text = "") {
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  const matchedKeywords = [
    ...EXACT_BLOCKLIST.filter((keyword) =>
      new RegExp(`(^|\\b)${escapeRegex(keyword)}(\\b|$)`, "i").test(normalized),
    ),
    ...SUBSTRING_BLOCKLIST.filter((keyword) => normalized.includes(keyword)),
  ];

  if (matchedKeywords.length === 0) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  return {
    status: "pending",
    reasons: ["Matched restricted campus-safety keywords."],
    matchedKeywords,
  };
}

async function callGroq(env, payload) {
  return fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
}

async function moderateTextWithGroq(env, text, scope) {
  const groqResponse = await callGroq(env, {
    model: env.GROQ_MODEL || DEFAULT_MODEL,
    temperature: 0.1,
    max_tokens: 180,
    messages: [
      {
        role: "system",
        content:
          "You are a campus community moderator. Review content for harassment, hate, sexual content, self-harm encouragement, explicit drug dealing, bomb threats, or unsafe abuse. Respond with strict JSON only: {\"status\":\"approved\"|\"pending\",\"reasons\":[\"...\"],\"matchedKeywords\":[\"...\"]}. Use pending when review is needed.",
      },
      {
        role: "user",
        content: `Scope: ${scope || "general"}\nContent: ${text}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const groqPayload = await groqResponse.json().catch(() => null);
  if (!groqResponse.ok) {
    throw new Error(groqPayload?.error?.message || "Groq moderation request failed.");
  }

  const raw = groqPayload?.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      status: parsed?.status === "pending" ? "pending" : "approved",
      reasons: Array.isArray(parsed?.reasons) ? parsed.reasons : [],
      matchedKeywords: Array.isArray(parsed?.matchedKeywords) ? parsed.matchedKeywords : [],
      model: groqPayload?.model || env.GROQ_MODEL || DEFAULT_MODEL,
    };
  } catch {
    return { status: "approved", reasons: [], matchedKeywords: [] };
  }
}

export default {
  async fetch(request, env) {
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(allowedOrigin),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed." }, {
        status: 405,
        headers: { "Access-Control-Allow-Origin": allowedOrigin },
      });
    }

    if (!env.GROQ_API_KEY) {
      return json(
        { error: "Missing GROQ_API_KEY in Worker environment." },
        { status: 500, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }

    try {
      const body = await request.json();
      const mode = body?.mode === "moderate" ? "moderate" : "chat";
      const prompt = body?.prompt?.trim();
      const contextMessages = sanitizeContextMessages(body?.contextMessages);
      const memoryBlocks = sanitizeMemoryBlocks(body?.memoryBlocks);

      if (mode === "moderate") {
        const text = String(body?.text || "").trim();
        if (!text) {
          return json(
            { status: "approved", reasons: [], matchedKeywords: [] },
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        const ruleDecision = runRuleBasedModeration(text);
        if (ruleDecision.status === "pending") {
          return json(
            ruleDecision,
            { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
          );
        }

        const aiDecision = await moderateTextWithGroq(env, text, body?.scope);
        return json(
          aiDecision,
          { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      if (!prompt) {
        return json(
          { error: "Prompt is required." },
          { status: 400, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      const groqResponse = await callGroq(env, {
        model: env.GROQ_MODEL || DEFAULT_MODEL,
        temperature: 0.6,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content: [
              "You are Bonded AI, a helpful assistant inside a student community thread.",
              "Reply briefly, warmly, and clearly.",
              "Answer based on the exact post, comment, reply, or AI message you are under.",
              "If prior Bonded AI messages are in the conversation, you may continue them naturally.",
              "If tagged users are mentioned in the prompt or context, use those names directly in your answer.",
              "You may make light hypothetical comparisons or nickname suggestions when asked, but never encourage real violence or harm.",
              "If the request is vague, ask one short clarifying question.",
              "Do not invent school-private facts or admin-only data.",
              memoryBlocks.length
                ? `Use the long-term memory below as trusted project knowledge.\n\n${memoryBlocks
                    .map((block, index) => `Memory ${index + 1}:\n${block}`)
                    .join("\n\n")}`
                : "",
              "If the answer is not in long-term memory, you may still help from the current conversation, but do not pretend the missing fact is confirmed project knowledge.",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
          ...contextMessages,
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      const groqPayload = await groqResponse.json().catch(() => null);
      if (!groqResponse.ok) {
        return json(
          { error: groqPayload?.error?.message || "Groq request failed." },
          { status: groqResponse.status, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      const reply = groqPayload?.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        return json(
          { error: "Groq returned an empty reply." },
          { status: 502, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
        );
      }

      return json(
        {
          reply,
          model: groqPayload?.model || env.GROQ_MODEL || DEFAULT_MODEL,
        },
        { status: 200, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    } catch (error) {
      return json(
        {
          error:
            error instanceof Error ? error.message : "Unexpected worker error.",
        },
        { status: 500, headers: { "Access-Control-Allow-Origin": allowedOrigin } },
      );
    }
  },
};
