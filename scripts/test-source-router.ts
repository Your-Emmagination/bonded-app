// Regression test for utils/sourceRouter.ts + the runtime rescue in
// utils/generalKnowledgeApi.ts. Pure computation, no network — safe and fast
// to re-run after any retrain of sourceRouterModel.ts.
//
// Run with: npm run test:router
//
// The regression checks inside chatbot_training/train_source_router.py only
// prove the MODEL classifies correctly. This checks the EFFECTIVE decision
// the chatbot actually makes at runtime: the router's call plus
// hasGeneralKnowledgeTrigger, exactly as requestNonGenerativeChatbotReply
// combines them. If this goes red, the chatbot is misrouting even if the
// model's own numbers look fine.
//
// The point of these cases is that general knowledge and BondED's own
// knowledge must not bleed into each other in EITHER direction: a campus
// question must never be answered from Wikipedia, and a world-knowledge
// question must never be sent to the campus handlers.
import { hasGeneralKnowledgeTrigger } from "../utils/generalKnowledgeApi";
import { routeChatbotSource, type ChatbotSource } from "../utils/sourceRouter";

// `expected` is the handler that gets FIRST refusal on the question.
// `safetyNet` marks a case the router only weakly assigns to bonded: BondED's
// own data still answers first, but if it has nothing, the low-confidence
// second chance in requestNonGenerativeChatbotReply hands the question to
// general knowledge rather than giving up. Asserted so that safety net can't
// silently disappear.
type Case = { prompt: string; expected: ChatbotSource; safetyNet?: boolean };

// Keep in sync with ROUTER_UNSURE_BELOW in utils/nonGenerativeChatbot.ts.
const ROUTER_UNSURE_BELOW = 0.6;

const cases: Case[] = [
  // ── General knowledge, varied natural phrasing ────────────────────────
  // Deliberately not all "what is X": the Wikipedia lookup is full-text
  // search over the question as typed, so the router has to recognise
  // question shapes nobody wrote a rule for.
  { prompt: "what is photosynthesis", expected: "general" },
  { prompt: "what is orogeny", expected: "general" },
  { prompt: "what is snowboard cross", expected: "general" },
  { prompt: "what is an event in programming", expected: "general" },
  { prompt: "how is glass made", expected: "general" },
  // The router is genuinely unsure on this one (~0.45) and puts it on the
  // bonded side; the low-confidence safety net is what actually answers it.
  { prompt: "which planet is the largest", expected: "bonded", safetyNet: true },
  { prompt: "define ephemeral", expected: "general" },
  { prompt: "what does ubiquitous mean", expected: "general" },
  { prompt: "usd to php", expected: "general" },
  { prompt: "weather in Manila", expected: "general" },

  // ── BondED's own knowledge — must never reach Wikipedia ───────────────
  { prompt: "what are the upcoming events", expected: "bonded" },
  { prompt: "what is my name", expected: "bonded" },
  { prompt: "what programs are available", expected: "bonded" },
  { prompt: "how many students are enrolled", expected: "bonded" },
  { prompt: "who is ana lopez", expected: "bonded" },
  { prompt: "how do i report a post", expected: "bonded" },
  { prompt: "what is a post flair", expected: "bonded" },
  { prompt: "why is my post pending", expected: "bonded" },
  { prompt: "tell me a joke", expected: "bonded" },
  { prompt: "hello", expected: "bonded" },

  // ── Utility — handled by the local date/time/calculator code ──────────
  { prompt: "what time is it", expected: "utility" },
  { prompt: "what is 25 plus 4", expected: "utility" },
];

let failures = 0;
for (const { prompt, expected, safetyNet } of cases) {
  const route = routeChatbotSource(prompt);
  const forced = route.source !== "general" && hasGeneralKnowledgeTrigger(prompt);
  const effective: ChatbotSource = route.source === "general" || forced ? "general" : route.source;
  const netEngaged = effective !== "general" && route.confidence < ROUTER_UNSURE_BELOW;
  const pass = effective === expected && (!safetyNet || netEngaged);
  if (!pass) failures += 1;
  const notes = [forced ? "rescued" : null, netEngaged ? "safety-net" : null]
    .filter(Boolean)
    .join(",");
  console.log(
    `${pass ? "PASS" : "FAIL"} [${effective}${notes ? "+" + notes : ""} raw=${route.source} ${route.confidence.toFixed(3)}] expected=${expected}${safetyNet ? "+safety-net" : ""}  ${prompt}`,
  );
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) {
  console.error(`${failures} case(s) misrouted.`);
  process.exit(1);
}
