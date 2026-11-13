// Regression test for utils/sourceRouter.ts. Pure computation, no network —
// safe and fast to re-run after any retrain of sourceRouterModel.ts.
//
// Run with: npm run test:router
//
// The on-phone bot answers BondED, campus and utility (date/time/math)
// questions. World knowledge is the AI's job through the Worker, so when the
// router sends a question to "general", the phone bot only says it can't look
// that up right now. What matters most is therefore the other direction: a
// BondED or campus question must never be routed to "general", or the student
// is told "I can't look that up" about their own school.
//
// Some world questions land on "bonded" (e.g. "define ephemeral"); there they
// simply find nothing in BondED's data and get the "couldn't find it" reply,
// which is harmless. They're listed so a retrain that changes them is noticed.
import { routeChatbotSource, type ChatbotSource } from "../utils/sourceRouter";

type Case = { prompt: string; expected: ChatbotSource };

const cases: Case[] = [
  // ── World knowledge the router recognises: phone bot says "can't look it up"
  { prompt: "what is photosynthesis", expected: "general" },
  { prompt: "what is orogeny", expected: "general" },
  { prompt: "what is snowboard cross", expected: "general" },
  { prompt: "what is an event in programming", expected: "general" },
  { prompt: "how is glass made", expected: "general" },
  { prompt: "usd to php", expected: "general" },
  // ── World knowledge it puts on the BondED side: finds nothing, says so
  { prompt: "which planet is the largest", expected: "bonded" },
  { prompt: "define ephemeral", expected: "bonded" },
  { prompt: "what does ubiquitous mean", expected: "bonded" },
  { prompt: "weather in Manila", expected: "bonded" },

  // ── BondED's own knowledge — must never be routed to "general" ─────────
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
for (const { prompt, expected } of cases) {
  const route = routeChatbotSource(prompt);
  const pass = route.source === expected;
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"} [${route.source} ${route.confidence.toFixed(3)}] expected=${expected}  ${prompt}`,
  );
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
if (failures > 0) {
  console.error(`${failures} case(s) misrouted.`);
  process.exit(1);
}
