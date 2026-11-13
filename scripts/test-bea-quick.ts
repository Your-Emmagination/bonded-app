/// <reference types="node" />
// Which messages B.E.A. answers on the phone with no AI call
// (answerQuickLocally in utils/nonGenerativeChatbot.ts). The important half is
// the second list: a school question must never get small talk, today's date
// or a sum instead of an answer.
//
// The chatbot module imports the app's Firebase and React Native setup, which
// can't run under Node; these stand-ins replace just those three imports.
/* eslint-disable @typescript-eslint/no-require-imports */
import assert from "node:assert/strict";

const Module = require("module");
const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (/Firebase_configure$/.test(request)) return { auth: { currentUser: null }, db: {} };
  if (request === "react-native") {
    return { Platform: { OS: "android" }, AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
  }
  if (request.startsWith("@react-native-async-storage")) {
    return { __esModule: true, default: { getItem: async () => null, setItem: async () => undefined } };
  }
  return originalLoad.call(this, request, ...rest);
};
const { answerQuickLocally, phoneFirstIntent } = require("../utils/nonGenerativeChatbot");

const onPhone: [string, string][] = [
  ["hi", "greeting"],
  ["hello bea", "greeting"],
  ["good morning", "greeting"],
  ["how are you?", "wellbeing"],
  ["thank you", "thanks"],
  ["salamat", "thanks"],
  ["bye", "goodbye"],
  ["what is your name", "assistant_identity"],
  ["what time is it", "time"],
  ["what's the date today", "date"],
  ["2+2", "calculator"],
  ["what is 25 * 4", "calculator"],
  ["15 x 3", "calculator"],
];
for (const [message, intent] of onPhone) {
  assert.equal(answerQuickLocally(message)?.intent, intent, `"${message}" should be answered on the phone`);
}

const toAi = [
  "hi who is our school president",
  "hello po, events?",
  "thanks, who is the dean",
  "hi what is bonded",
  "thank you, can you also tell me the events?",
  "when is the foundation day",
  "what time is the program tomorrow",
  "what day is the intramurals",
  "what time does the library open",
  "who are the school officers for 2026-2027",
  "what is photosynthesis",
  "who is the dean",
];
for (const message of toAi) {
  assert.equal(answerQuickLocally(message), null, `"${message}" must go to the AI`);
}

// BondED's own records: the asker's profile, and people in BondED. The phone
// has them and the AI doesn't, so these are answered here too
// (phoneFirstIntent / answerPhoneFirst).
const phoneFirst: [string, "self" | "person" | null][] = [
  ["what is my student id", "self"],
  ["what's my student number", "self"],
  ["ano student id ko", "self"],
  ["what is my course", "self"],
  ["what program am i in", "self"],
  ["what is my year level", "self"],
  ["who am i", "self"],
  ["what is my name", "self"],
  ["who is ana lopez", "person"],
  // Everything else is the AI's (with its tools for events and programs).
  ["what are the programs", null],
  ["what are the upcoming events", null],
  ["who is our dean", null],
  ["who is jose rizal", null],
  ["who is the president of the philippines", null],
  ["what is photosynthesis", null],
  ["how do i change my password", null],
];
for (const [message, kind] of phoneFirst) {
  assert.equal(phoneFirstIntent(message), kind, `"${message}" should be ${kind ?? "the AI's"}`);
}

console.log(`B.E.A. quick answers: ${onPhone.length + toAi.length + phoneFirst.length} checks passed.`);
