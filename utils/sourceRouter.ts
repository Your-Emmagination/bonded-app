import { SOURCE_ROUTER_MODEL } from "./sourceRouterModel";

export type ChatbotSource = "bonded" | "general" | "utility";

export type SourceRoute = {
  source: ChatbotSource;
  confidence: number;
  probabilities: Record<ChatbotSource, number>;
};

const termIndex = new Map<string, number>(
  SOURCE_ROUTER_MODEL.terms.map((term, index) => [term, index]),
);

const normalizeRouterText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/[^a-z0-9+\-*/().%\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const vectorize = (input: string) => {
  const normalized = normalizeRouterText(input);
  const tokens = normalized.match(/\b\w+\b/g) || [];
  const counts = new Map<number, number>();

  const addTerm = (term: string) => {
    const index = termIndex.get(term);
    if (index == null) return;
    counts.set(index, (counts.get(index) || 0) + 1);
  };

  for (const token of tokens) addTerm(token);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    addTerm(`${tokens[index]} ${tokens[index + 1]}`);
  }

  const vector = new Map<number, number>();
  let squaredNorm = 0;

  for (const [index, count] of counts) {
    const tf = 1 + Math.log(count);
    const value = tf * Number(SOURCE_ROUTER_MODEL.idf[index] || 0);
    vector.set(index, value);
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm) || 1;
  for (const [index, value] of vector) {
    vector.set(index, value / norm);
  }

  return vector;
};

const relu = (value: number) => (value > 0 ? value : 0);

const softmax = (values: number[]) => {
  const max = Math.max(...values);
  const exp = values.map((value) => Math.exp(value - max));
  const total = exp.reduce((sum, value) => sum + value, 0) || 1;
  return exp.map((value) => value / total);
};

export const routeChatbotSource = (input: string): SourceRoute => {
  const features = vectorize(input);
  const firstLayer = SOURCE_ROUTER_MODEL.coefs[0];
  const firstBias = SOURCE_ROUTER_MODEL.intercepts[0];
  const hiddenSize = firstBias.length;
  const hidden = new Array<number>(hiddenSize).fill(0);

  for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
    hidden[hiddenIndex] = Number(firstBias[hiddenIndex] || 0);
  }

  // Sparse input × dense first-layer weights.
  for (const [featureIndex, featureValue] of features) {
    const row = firstLayer[featureIndex];
    if (!row) continue;
    for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
      hidden[hiddenIndex] += Number(row[hiddenIndex] || 0) * featureValue;
    }
  }

  for (let hiddenIndex = 0; hiddenIndex < hiddenSize; hiddenIndex += 1) {
    hidden[hiddenIndex] = relu(hidden[hiddenIndex]);
  }

  const secondLayer = SOURCE_ROUTER_MODEL.coefs[1];
  const secondBias = SOURCE_ROUTER_MODEL.intercepts[1];
  const output = SOURCE_ROUTER_MODEL.classes.map((_, classIndex) => {
    let score = Number(secondBias[classIndex] || 0);
    for (let hiddenIndex = 0; hiddenIndex < hidden.length; hiddenIndex += 1) {
      score +=
        hidden[hiddenIndex] * Number(secondLayer[hiddenIndex]?.[classIndex] || 0);
    }
    return score;
  });

  const probabilitiesArray = softmax(output);
  const probabilities: Record<ChatbotSource, number> = {
    bonded: 0,
    general: 0,
    utility: 0,
  };

  SOURCE_ROUTER_MODEL.classes.forEach((label, index) => {
    probabilities[label as ChatbotSource] = probabilitiesArray[index] || 0;
  });

  const ranked = (Object.entries(probabilities) as [ChatbotSource, number][]).sort(
    (a, b) => b[1] - a[1],
  );

  return {
    source: ranked[0]?.[0] || "bonded",
    confidence: ranked[0]?.[1] || 0,
    probabilities,
  };
};

export const getSourceRouterDiagnostics = () => ({
  model: SOURCE_ROUTER_MODEL.modelName,
  algorithm: SOURCE_ROUTER_MODEL.algorithm,
  generative: SOURCE_ROUTER_MODEL.generative,
  epochsTrained: SOURCE_ROUTER_MODEL.epochsTrained,
  validationAccuracy: SOURCE_ROUTER_MODEL.validationAccuracy,
  vocabularySize: SOURCE_ROUTER_MODEL.terms.length,
});
