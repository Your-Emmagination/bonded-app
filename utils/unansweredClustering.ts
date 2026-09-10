/**
 * Groups similar unanswered chatbot questions together so staff can see
 * "12 students asked something like this" instead of reading through the
 * raw log one entry at a time, and turns each group into a ready-to-open
 * AI Memory draft.
 *
 * Deterministic word-overlap clustering — same spirit as the TF-IDF/overlap
 * scoring already used throughout utils/nonGenerativeChatbot.ts, just a
 * simpler self-contained version here since this doesn't need fuzzy typo
 * correction or synonyms: clustering questions together is lower-stakes
 * than answering one (a stray question ending up in the wrong cluster just
 * means a staff member sees it in a slightly odd group, not a wrong answer
 * shown to a student), so a plain Jaccard-style overlap is enough.
 *
 * IMPORTANT: this NEVER drafts an answer. It only suggests a title (cleaned
 * up from the most common phrasing) and tags (the most frequent real words
 * students actually used) — the content field is always left blank for a
 * staff member to write themselves. This tool's job is "here's a pattern
 * worth answering," never "here's what the answer should be."
 */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did",
  "what", "when", "where", "who", "why", "how", "can", "could", "would",
  "should", "will", "shall", "in", "on", "at", "to", "of", "for", "and",
  "or", "but", "i", "you", "your", "my", "me", "it", "this", "that",
  "there", "here", "please", "po", "ba", "ang", "ng", "sa", "mga",
]);

const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));

const jaccardSimilarity = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
};

export type UnansweredQuestionInput = {
  id: string;
  prompt: string;
  createdAtMs?: number;
};

export type UnansweredQuestionCluster = {
  representativePrompt: string;
  members: UnansweredQuestionInput[];
  count: number;
  suggestedTitle: string;
  suggestedTags: string[];
};

// Requires roughly 2-in-5 shared meaningful words to group two questions
// together. Deliberately on the stricter side — grouping two unrelated
// questions together is more confusing for staff to review than leaving a
// question in its own small cluster.
const CLUSTER_SIMILARITY_THRESHOLD = 0.4;

const toTitle = (prompt: string): string => {
  const trimmed = prompt.trim();
  if (!trimmed) return "";
  const capitalized = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  const withoutTrailingPunctuation = capitalized.replace(/[?.!]+$/, "");
  return withoutTrailingPunctuation.length > 80
    ? `${withoutTrailingPunctuation.slice(0, 77)}...`
    : withoutTrailingPunctuation;
};

const suggestTags = (members: UnansweredQuestionInput[]): string[] => {
  const frequency = new Map<string, number>();
  for (const member of members) {
    for (const token of new Set(tokenize(member.prompt))) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }
  }
  return [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token]) => token);
};

/**
 * Groups the given unanswered questions, returns clusters sorted by size
 * (most-asked first) so staff naturally see the highest-impact gaps first.
 * Pure function — no Firestore/network access, just takes whatever list the
 * caller already fetched.
 */
export const clusterUnansweredQuestions = (
  questions: UnansweredQuestionInput[],
): UnansweredQuestionCluster[] => {
  type WorkingCluster = {
    tokens: Set<string>;
    members: UnansweredQuestionInput[];
  };
  const clusters: WorkingCluster[] = [];

  for (const question of questions) {
    const tokens = new Set(tokenize(question.prompt));
    if (tokens.size === 0) continue;

    let bestCluster: WorkingCluster | null = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const score = jaccardSimilarity(tokens, cluster.tokens);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }

    if (bestCluster && bestScore >= CLUSTER_SIMILARITY_THRESHOLD) {
      bestCluster.members.push(question);
      // Widen the cluster's token set with this question's words too, so
      // later questions can match against the group's full vocabulary, not
      // just the first question that started it.
      for (const token of tokens) bestCluster.tokens.add(token);
    } else {
      clusters.push({ tokens, members: [question] });
    }
  }

  return clusters
    .map((cluster) => {
      // Prefer the longest member as the representative — usually the most
      // descriptive phrasing of the group's underlying question.
      const representative = cluster.members.reduce((longest, current) =>
        current.prompt.length > longest.prompt.length ? current : longest,
      );
      return {
        representativePrompt: representative.prompt,
        members: cluster.members,
        count: cluster.members.length,
        suggestedTitle: toTitle(representative.prompt),
        suggestedTags: suggestTags(cluster.members),
      };
    })
    .sort((a, b) => b.count - a.count);
};
