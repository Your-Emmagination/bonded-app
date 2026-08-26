import { GENERAL_KNOWLEDGE_INDEX } from "./generalKnowledgeIndex";

export type GeneralKnowledgeMatch = {
  answer: string;
  matchedQuestion: string;
  similarity: number;
  secondBestSimilarity: number;
};

const MIN_SIMILARITY = 0.52;
const MIN_MARGIN = 0.025;

const vocabulary = new Map<string, number>(
  Object.entries(GENERAL_KNOWLEDGE_INDEX.vocabulary).map(([term, index]) => [
    term,
    Number(index),
  ]),
);

const stopWords = new Set<string>(GENERAL_KNOWLEDGE_INDEX.stopWords);

const normalizeKnowledgeText = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/@(?:ai|bondedai)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const vectorizeKnowledgeQuery = (input: string) => {
  const normalized = normalizeKnowledgeText(input);
  const rawTokens = normalized.match(/\b[a-z0-9]+\b/g) || [];
  const tokens = rawTokens.filter((token) => !stopWords.has(token));

  const counts = new Map<number, number>();

  const addTerm = (term: string) => {
    const index = vocabulary.get(term);
    if (index == null) return;
    counts.set(index, (counts.get(index) || 0) + 1);
  };

  for (const token of tokens) {
    addTerm(token);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    addTerm(`${tokens[index]} ${tokens[index + 1]}`);
  }

  if (counts.size === 0) return new Map<number, number>();

  const weighted = new Map<number, number>();
  let squaredNorm = 0;

  for (const [featureIndex, count] of counts) {
    // scikit-learn sublinear_tf=True => 1 + log(tf)
    const tf = 1 + Math.log(count);
    const idf = Number(GENERAL_KNOWLEDGE_INDEX.idf[featureIndex] || 0);
    const value = tf * idf;

    weighted.set(featureIndex, value);
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm) || 1;

  for (const [featureIndex, value] of weighted) {
    weighted.set(featureIndex, value / norm);
  }

  return weighted;
};

const sparseDotProduct = (
  query: Map<number, number>,
  indices: readonly number[],
  values: readonly number[],
) => {
  let score = 0;

  for (let index = 0; index < indices.length; index += 1) {
    const queryValue = query.get(Number(indices[index]));
    if (queryValue != null) {
      score += queryValue * Number(values[index] || 0);
    }
  }

  return score;
};

export const retrieveGeneralKnowledge = (
  input: string,
): GeneralKnowledgeMatch | null => {
  const query = vectorizeKnowledgeQuery(input);
  if (query.size === 0) return null;

  let bestIndex = -1;
  let bestSimilarity = 0;
  let secondBestSimilarity = 0;

  for (
    let index = 0;
    index < GENERAL_KNOWLEDGE_INDEX.vectors.length;
    index += 1
  ) {
    const candidate = GENERAL_KNOWLEDGE_INDEX.vectors[index];
    const similarity = sparseDotProduct(
      query,
      candidate.indices,
      candidate.values,
    );

    if (similarity > bestSimilarity) {
      secondBestSimilarity = bestSimilarity;
      bestSimilarity = similarity;
      bestIndex = index;
    } else if (similarity > secondBestSimilarity) {
      secondBestSimilarity = similarity;
    }
  }

  if (bestIndex < 0 || bestSimilarity < MIN_SIMILARITY) {
    return null;
  }

  // Ambiguous low-confidence nearest neighbors are rejected instead of
  // returning a confident but unrelated stored answer.
  if (
    bestSimilarity < 0.60 &&
    bestSimilarity - secondBestSimilarity < MIN_MARGIN
  ) {
    return null;
  }

  return {
    answer: String(GENERAL_KNOWLEDGE_INDEX.answers[bestIndex] || "").trim(),
    matchedQuestion: String(
      GENERAL_KNOWLEDGE_INDEX.questions[bestIndex] || "",
    ).trim(),
    similarity: bestSimilarity,
    secondBestSimilarity,
  };
};

export const getGeneralKnowledgeDiagnostics = () => ({
  name: GENERAL_KNOWLEDGE_INDEX.metadata.name,
  algorithm: GENERAL_KNOWLEDGE_INDEX.metadata.algorithm,
  generative: GENERAL_KNOWLEDGE_INDEX.metadata.generative,
  entries: GENERAL_KNOWLEDGE_INDEX.metadata.questionCount,
  vocabularySize: GENERAL_KNOWLEDGE_INDEX.metadata.vocabularySize,
  minimumSimilarity: MIN_SIMILARITY,
});
