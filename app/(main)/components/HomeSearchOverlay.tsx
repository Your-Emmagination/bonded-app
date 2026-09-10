// HomeSearchOverlay.tsx
//
// Home's search experience: the search bar that takes over the header, the
// suggestions dropdown, and the full results screen. All search state lives in
// HomeSearchProvider rather than HomeScreen, so typing only re-renders the
// search UI instead of the whole feed screen.
import { avatarThumb } from "@/utils/cloudinaryImages";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import {
  createContext,
  useCallback,
  useContext,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import type {
  FeedItem,
  PollFeedItem,
  PostFeedItem,
  SearchableStudent,
} from "../(tabs)/HomeScreen";

const HOME_SEARCH_HISTORY_KEY = "bonded.homeSearchHistory";

type SearchTab = "all" | "posts" | "polls" | "people";
type SearchDateFilter = "all" | "today" | "week" | "month" | "year";
type SearchSort = "relevance" | "newest" | "oldest";

export type SearchResult = {
  id: string;
  kind: "post" | "poll" | "person";
  sourceId: string;
  // People results need both identities: the auth uid owns posts/polls, while
  // profileDocId identifies the students/{docId} profile document.
  userId?: string;
  profileDocId?: string;
  avatarUri?: string | null;
  title: string;
  subtitle: string;
  meta?: string;
  avatarLabel: string;
  timestamp: number;
  score: number;
  haystack: string;
  matchPositions?: number[];
};

type SearchSuggestion = {
  id: string;
  label: string;
  hint: string;
  query: string;
  kind: SearchResult["kind"] | "recent" | "trending";
};

type RenderFeedItem = (info: { item: FeedItem }) => ReactElement;

type HomeSearchContextValue = {
  query: string;
  trimmedQuery: string;
  tab: SearchTab;
  dateFilter: SearchDateFilter;
  sort: SearchSort;
  results: SearchResult[];
  suggestions: SearchSuggestion[];
  peopleResults: SearchResult[];
  contentResults: SearchResult[];
  matchedFeedItems: FeedItem[];
  showResults: boolean;
  renderFeedItem: RenderFeedItem;
  changeQuery: (value: string) => void;
  clearQuery: () => void;
  submit: () => void;
  pressSuggestion: (suggestion: SearchSuggestion) => void;
  pressTab: (tab: SearchTab) => void;
  pressDateFilter: (filter: SearchDateFilter) => void;
  toggleSort: () => void;
  pressResult: (result: SearchResult) => void;
  close: () => void;
};

type HomeSearchProviderProps = {
  expanded: boolean;
  visibleFeedItems: FeedItem[];
  searchableStudents: SearchableStudent[];
  renderFeedItem: RenderFeedItem;
  // Returns false when the result can't be opened (a post that has left the
  // feed), so search stays open and the query isn't saved as a recent search.
  onOpenResult: (result: SearchResult) => boolean;
  onClose: () => void;
  // Lets HomeScreen pause feed videos while results cover the feed.
  onResultsVisibleChange: (visible: boolean) => void;
  children: ReactNode;
};

const SEARCH_TABS: { key: SearchTab; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "posts", label: "Posts" },
  { key: "polls", label: "Polls" },
  { key: "people", label: "People" },
];

const DATE_FILTERS: { key: SearchDateFilter; label: string }[] = [
  { key: "all", label: "Any time" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "year", label: "This year" },
];

// Returned while search is closed, so the memos below hand back the same empty
// array instead of rescanning the feed on every realtime update.
const EMPTY_RESULTS: SearchResult[] = [];
const EMPTY_FEED_ITEMS: FeedItem[] = [];

const getTimestampValue = (value: any) => value?.toMillis?.() || 0;

const getDateFilterThreshold = (filter: SearchDateFilter) => {
  const now = new Date();
  if (filter === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  if (filter === "week") {
    return now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }
  if (filter === "month") {
    return now.getTime() - 30 * 24 * 60 * 60 * 1000;
  }
  if (filter === "year") {
    return now.getTime() - 365 * 24 * 60 * 60 * 1000;
  }
  return 0;
};

const getSearchTokens = (value: string): string[] =>
  value
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

const fuzzyMatchScore = (haystack: string, token: string): number => {
  if (haystack.includes(token)) return 10;
  if (haystack.startsWith(token)) return 8;
  const index = haystack.indexOf(token);
  if (index > -1) return Math.max(1, 6 - Math.floor(index / 3));
  return 0;
};

const computeAdvancedScore = (
  haystack: string,
  tokens: string[],
  timestamp = 0,
  likeCount = 0,
  voteCount = 0,
) => {
  let score = tokens.reduce((sum, token) => sum + fuzzyMatchScore(haystack, token), 0);

  score += (likeCount || 0) * 0.015;
  score += (voteCount || 0) * 0.01;

  if (timestamp > 0) {
    const daysOld = (Date.now() - timestamp) / (1000 * 60 * 60 * 24);
    if (daysOld < 7) score += 3;
    else if (daysOld < 30) score += 1.5;
  }

  return score;
};

const matchesAllTokens = (haystack: string, tokens: string[]) =>
  tokens.every((token) => haystack.includes(token));

const getSearchResultIconName = (kind: SearchResult["kind"]) => {
  if (kind === "person") return "person";
  if (kind === "poll") return "bar-chart";
  return "document-text";
};

const getSearchSuggestionIconName = (kind: SearchSuggestion["kind"]) => {
  if (kind === "recent") return "time-outline";
  if (kind === "trending") return "sparkles-outline";
  return getSearchResultIconName(kind);
};

const HomeSearchContext = createContext<HomeSearchContextValue | null>(null);

const useHomeSearch = () => {
  const value = useContext(HomeSearchContext);
  if (!value) {
    throw new Error("Home search UI must be rendered inside HomeSearchProvider.");
  }
  return value;
};

export default function HomeSearchProvider({
  expanded,
  visibleFeedItems,
  searchableStudents,
  renderFeedItem,
  onOpenResult,
  onClose,
  onResultsVisibleChange,
  children,
}: HomeSearchProviderProps) {
  const [query, setQuery] = useState("");
  const [committed, setCommitted] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [tab, setTab] = useState<SearchTab>("all");
  const [dateFilter, setDateFilter] = useState<SearchDateFilter>("all");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    const loadRecentSearches = async () => {
      try {
        const storedSearches = await AsyncStorage.getItem(HOME_SEARCH_HISTORY_KEY);
        if (storedSearches) setRecentSearches(JSON.parse(storedSearches));
      } catch (error) {
        console.error("Error loading recent searches:", error);
      }
    };
    loadRecentSearches();
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(
      HOME_SEARCH_HISTORY_KEY,
      JSON.stringify(recentSearches.slice(0, 8)),
    ).catch((error) => console.error("Error saving recent searches:", error));
  }, [recentSearches]);

  const trendingSuggestions = useMemo<SearchResult[]>(() => {
    if (!expanded) return EMPTY_RESULTS;
    const threshold = getDateFilterThreshold(dateFilter);

    return visibleFeedItems
      .filter(
        (item) =>
          item.type !== "post" ||
          getTimestampValue(item.createdAt) >= threshold,
      )
      .map((item) => {
        if (item.type === "post") {
          const timestamp = getTimestampValue(item.createdAt);
          const haystack = [
            item.content,
            item.username,
            item.link?.title,
            item.link?.url,
            ...(item.taggedUsers || []).map((tag) => `${tag.name} ${tag.studentID}`),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return {
            id: `post:${item.id}`,
            kind: "post" as const,
            sourceId: item.id,
            title: item.username || "Post",
            subtitle:
              item.content?.slice(0, 120) || item.link?.title || "Media content",
            meta: `${item.likeCount || 0} likes • ${item.commentCount || 0} comments`,
            avatarLabel: "P",
            timestamp,
            score: computeAdvancedScore(
              haystack,
              [],
              timestamp,
              item.likeCount || 0,
              0,
            ),
            haystack,
          };
        }

        const timestamp = getTimestampValue(item.createdAt);
        const haystack = [item.question, item.username, ...item.options.map((option) => option.text)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          id: `poll:${item.id}`,
          kind: "poll" as const,
          sourceId: item.id,
          title: item.question,
          subtitle: `${item.options.length} options • ${item.totalVotes} votes`,
          meta: `${item.totalVotes} votes`,
          avatarLabel: "V",
          timestamp,
          score: computeAdvancedScore(haystack, [], timestamp, 0, item.totalVotes || 0),
          haystack,
        };
      })
      .sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
      .slice(0, 12);
  }, [dateFilter, expanded, visibleFeedItems]);

  const results = useMemo<SearchResult[]>(() => {
    if (!expanded) return EMPTY_RESULTS;
    if (!deferredQuery.trim() && tab === "all") {
      return trendingSuggestions;
    }

    const tokens = getSearchTokens(deferredQuery);
    const threshold = getDateFilterThreshold(dateFilter);

    const postResults: SearchResult[] = visibleFeedItems
      .filter((item): item is PostFeedItem => item.type === "post")
      .map((post) => {
        const haystack = [
          post.content,
          post.username,
          post.link?.title,
          post.link?.url,
          ...(post.taggedUsers || []).map((t) => `${t.name} ${t.studentID}`),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          id: `post:${post.id}`,
          kind: "post" as const,
          sourceId: post.id,
          title: post.username || "Post",
          subtitle: post.content?.slice(0, 120) || post.link?.title || "Media content",
          meta: `${post.likeCount || 0} likes • ${post.commentCount || 0} comments`,
          avatarLabel: "P",
          timestamp: getTimestampValue(post.createdAt),
          score: computeAdvancedScore(
            haystack,
            tokens,
            getTimestampValue(post.createdAt),
            post.likeCount || 0,
            0,
          ),
          haystack,
        };
      })
      .filter(
        (item) =>
          item.timestamp >= threshold &&
          (tokens.length === 0 || matchesAllTokens(item.haystack, tokens)),
      );

    const pollResults: SearchResult[] = visibleFeedItems
      .filter((item): item is PollFeedItem => item.type === "poll")
      .map((poll) => {
        const haystack = [
          poll.question,
          poll.username,
          ...poll.options.map((o) => o.text),
        ].join(" ").toLowerCase();

        return {
          id: `poll:${poll.id}`,
          kind: "poll" as const,
          sourceId: poll.id,
          title: poll.question,
          subtitle: `${poll.options.length} options • ${poll.totalVotes} votes`,
          meta: `${poll.totalVotes} votes`,
          avatarLabel: "V",
          timestamp: getTimestampValue(poll.createdAt),
          score: computeAdvancedScore(
            haystack,
            tokens,
            getTimestampValue(poll.createdAt),
            0,
            poll.totalVotes || 0,
          ),
          haystack,
        };
      })
      .filter(
        (item) =>
          item.timestamp >= threshold &&
          (tokens.length === 0 || matchesAllTokens(item.haystack, tokens)),
      );

    const personResults: SearchResult[] = searchableStudents
      .map((person) => {
        const fullName = `${person.firstname} ${person.lastname}`.trim();
        const haystack = [fullName, person.studentID, person.course, person.role]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return {
          id: `person:${person.id}`,
          kind: "person" as const,
          // sourceId is the content owner id when available. The previous code
          // always used the students document id here, which could be a student
          // number/email prefix instead of the Firebase Auth uid.
          sourceId: person.userId || person.id,
          userId: person.userId,
          profileDocId: person.id,
          avatarUri: person.profileImage || null,
          title: fullName || "Student",
          subtitle: person.course ? `${person.course} • ${person.role || "Member"}` : "BondED Member",
          meta: person.studentID,
          avatarLabel: `${person.firstname?.[0] || ""}${person.lastname?.[0] || ""}`.toUpperCase() || "U",
          timestamp: 0,
          score: computeAdvancedScore(haystack, tokens),
          haystack,
        };
      })
      .filter((item) => tokens.length === 0 || matchesAllTokens(item.haystack, tokens));

    let combined = [...postResults, ...pollResults, ...personResults];

    if (tab !== "all") {
      const tabKind =
        tab === "posts" ? "post" :
        tab === "polls" ? "poll" :
        tab === "people" ? "person" :
        undefined;

      if (tabKind) {
        combined = combined.filter((r) => r.kind === tabKind);
      }
    }

    combined.sort((a, b) => {
      if (sort === "newest") return b.timestamp - a.timestamp;
      if (sort === "oldest") return a.timestamp - b.timestamp;
      // Relevance + recency
      if (Math.abs(b.score - a.score) > 0.5) return b.score - a.score;
      return b.timestamp - a.timestamp;
    });

    return combined.slice(0, 40);
  }, [
    dateFilter,
    deferredQuery,
    expanded,
    searchableStudents,
    sort,
    tab,
    trendingSuggestions,
    visibleFeedItems,
  ]);

  const trimmedQuery = query.trim();
  const isFiltered =
    tab !== "all" || dateFilter !== "all" || sort !== "relevance";
  const showResults = expanded && (committed || isFiltered);

  const suggestions = useMemo<SearchSuggestion[]>(() => {
    if (trimmedQuery) {
      return results.slice(0, 5).map((result) => ({
        id: `match-${result.id}`,
        label: result.title,
        hint: result.subtitle,
        query: trimmedQuery,
        kind: result.kind,
      }));
    }

    const recent = recentSearches.slice(0, 4).map((recentQuery) => ({
      id: `recent-${recentQuery}`,
      label: recentQuery,
      hint: "Recent search",
      query: recentQuery,
      kind: "recent" as const,
    }));

    const trending = trendingSuggestions.slice(0, 3).map((result) => ({
      id: `trending-${result.id}`,
      label: result.title,
      hint: result.meta || "Trending on Home",
      query: result.title,
      kind: "trending" as const,
    }));

    return [...recent, ...trending].slice(0, 6);
  }, [recentSearches, results, trendingSuggestions, trimmedQuery]);

  const peopleResults = useMemo(
    () => results.filter((result) => result.kind === "person").slice(0, 4),
    [results],
  );

  const contentResults = useMemo(
    () => results.filter((result) => result.kind !== "person"),
    [results],
  );

  const matchedFeedItems = useMemo<FeedItem[]>(() => {
    if (contentResults.length === 0) return EMPTY_FEED_ITEMS;
    const orderLookup = new Map(
      contentResults.map((result, index) => [
        `${result.kind}:${result.sourceId}`,
        index,
      ]),
    );

    return visibleFeedItems
      .filter((item) => orderLookup.has(`${item.type}:${item.id}`))
      .sort(
        (first, second) =>
          (orderLookup.get(`${first.type}:${first.id}`) ?? 0) -
          (orderLookup.get(`${second.type}:${second.id}`) ?? 0),
      )
      .slice(0, 6);
  }, [contentResults, visibleFeedItems]);

  useEffect(() => {
    onResultsVisibleChange(showResults);
  }, [onResultsVisibleChange, showResults]);

  const rememberSearch = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setRecentSearches((previous) => [
      trimmed,
      ...previous.filter((item) => item.toLowerCase() !== trimmed.toLowerCase()),
    ].slice(0, 8));
  }, []);

  // Every way out of search (Cancel, or opening a result) runs through here,
  // so the next time search opens it starts clean.
  const resetSearch = useCallback(() => {
    setCommitted(false);
    setQuery("");
    setTab("all");
    setDateFilter("all");
    setSort("relevance");
  }, []);

  const close = useCallback(() => {
    resetSearch();
    onClose();
  }, [onClose, resetSearch]);

  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    if (!value.trim()) {
      setCommitted(false);
    }
  }, []);

  const clearQuery = useCallback(() => {
    setQuery("");
    setCommitted(false);
  }, []);

  const submit = useCallback(() => {
    rememberSearch(query);
    setCommitted(true);
  }, [query, rememberSearch]);

  const pressSuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      setQuery(suggestion.query);
      rememberSearch(suggestion.query);
      setCommitted(true);
    },
    [rememberSearch],
  );

  const pressTab = useCallback((nextTab: SearchTab) => {
    setTab(nextTab);
    setCommitted(true);
  }, []);

  const pressDateFilter = useCallback((filter: SearchDateFilter) => {
    setDateFilter(filter);
    setCommitted(true);
  }, []);

  const toggleSort = useCallback(() => {
    const nextSort =
      sort === "relevance"
        ? "newest"
        : sort === "newest"
          ? "oldest"
          : "relevance";
    setSort(nextSort);
    setCommitted(true);
  }, [sort]);

  const pressResult = useCallback(
    (result: SearchResult) => {
      if (!onOpenResult(result)) return;
      rememberSearch(query || result.title);
      resetSearch();
    },
    [onOpenResult, query, rememberSearch, resetSearch],
  );

  const value = useMemo<HomeSearchContextValue>(
    () => ({
      query,
      trimmedQuery,
      tab,
      dateFilter,
      sort,
      results,
      suggestions,
      peopleResults,
      contentResults,
      matchedFeedItems,
      showResults,
      renderFeedItem,
      changeQuery,
      clearQuery,
      submit,
      pressSuggestion,
      pressTab,
      pressDateFilter,
      toggleSort,
      pressResult,
      close,
    }),
    [
      changeQuery,
      clearQuery,
      close,
      contentResults,
      dateFilter,
      matchedFeedItems,
      peopleResults,
      pressDateFilter,
      pressResult,
      pressSuggestion,
      pressTab,
      query,
      renderFeedItem,
      results,
      showResults,
      sort,
      submit,
      suggestions,
      tab,
      toggleSort,
      trimmedQuery,
    ],
  );

  return (
    <HomeSearchContext.Provider value={value}>
      {children}
    </HomeSearchContext.Provider>
  );
}

type HomeSearchBarProps = {
  onOpenServerDrawer: () => void;
};

// Takes over the header's contents while search is open.
export function HomeSearchBar({ onOpenServerDrawer }: HomeSearchBarProps) {
  const { query, changeQuery, clearQuery, submit, close } = useHomeSearch();
  const inputRef = useRef<TextInput>(null);

  // The same delayed focus the search button used to trigger, kept alongside
  // autoFocus.
  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.headerSearchRow}>
      <TouchableOpacity
        style={styles.headerIconButton}
        activeOpacity={0.82}
        onPress={onOpenServerDrawer}
      >
        <Ionicons name="menu" size={22} color="#f4e7df" />
      </TouchableOpacity>

      <View style={styles.headerSearchBar}>
        <Ionicons name="search" size={20} color="#7f4d44" />
        <TextInput
          ref={inputRef}
          style={styles.headerSearchInput}
          value={query}
          onChangeText={changeQuery}
          placeholder="Search people, posts, or polls"
          placeholderTextColor="#af8478"
          returnKeyType="search"
          autoFocus
          onSubmitEditing={submit}
        />
        {query.length > 0 ? (
          <TouchableOpacity onPress={clearQuery} activeOpacity={0.82}>
            <Ionicons name="close-circle" size={20} color="#c47e6e" />
          </TouchableOpacity>
        ) : null}
      </View>

      <TouchableOpacity
        onPress={close}
        style={styles.searchCancelButton}
        activeOpacity={0.82}
      >
        <Text style={styles.searchCancelText}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

// Rendered inside HomeScreen's content area, on top of the feed: the
// suggestions dropdown while typing, or the results screen once a search is
// submitted or filtered.
export function HomeSearchPanel() {
  const { showResults } = useHomeSearch();
  return showResults ? <SearchResultsScreen /> : <SearchDropdown />;
}

function SearchDropdown() {
  const { trimmedQuery, suggestions, submit, pressSuggestion } = useHomeSearch();

  return (
    <View style={styles.searchDropdownCard}>
      <View style={styles.searchDropdownHeader}>
        <Text style={styles.searchDropdownTitle}>
          {trimmedQuery ? "Quick matches" : "Recent and trending"}
        </Text>
        {trimmedQuery ? (
          <TouchableOpacity onPress={submit} activeOpacity={0.82}>
            <Text style={styles.searchDropdownAction}>See all</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {suggestions.length > 0 ? (
        suggestions.map((suggestion) => (
          <TouchableOpacity
            key={suggestion.id}
            style={styles.searchSuggestionRow}
            onPress={() => pressSuggestion(suggestion)}
            activeOpacity={0.86}
          >
            <View style={styles.searchSuggestionIconWrap}>
              <Ionicons
                name={getSearchSuggestionIconName(suggestion.kind)}
                size={18}
                color="#7c2a22"
              />
            </View>
            <View style={styles.searchSuggestionCopy}>
              <Text style={styles.searchSuggestionTitle} numberOfLines={1}>
                {suggestion.label}
              </Text>
              <Text style={styles.searchSuggestionHint} numberOfLines={1}>
                {suggestion.hint}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color="#c47e6e" />
          </TouchableOpacity>
        ))
      ) : (
        <View style={styles.searchDropdownEmpty}>
          <Ionicons name="search-outline" size={22} color="#c9a89a" />
          <Text style={styles.searchDropdownEmptyText}>
            Start typing to search Home.
          </Text>
        </View>
      )}
    </View>
  );
}

function SearchResultsScreen() {
  const {
    contentResults,
    dateFilter,
    matchedFeedItems,
    peopleResults,
    pressDateFilter,
    pressResult,
    pressTab,
    renderFeedItem,
    results,
    sort,
    tab,
    toggleSort,
    trimmedQuery,
  } = useHomeSearch();

  const showPeopleSection = tab === "all" || tab === "people";
  const showContentSection =
    tab === "all" || tab === "posts" || tab === "polls";
  const resultSummary = trimmedQuery
    ? `Showing ${results.length} matches${dateFilter === "all" ? "" : ` from ${dateFilter === "today" ? "today" : dateFilter === "week" ? "this week" : dateFilter === "month" ? "this month" : "this year"}`}.`
    : "Browse people and recent community activity with simple filters.";

  return (
    <View style={styles.resultsOverlay}>
      <ScrollView
        style={styles.searchScreen}
        contentContainerStyle={styles.searchScreenContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.searchOverviewCard}>
          <View style={styles.searchOverviewIcon}>
            <Ionicons
              name={trimmedQuery ? "sparkles" : "search"}
              size={20}
              color="#5f0909"
            />
          </View>
          <View style={styles.searchOverviewCopy}>
            <Text style={styles.searchOverviewTitle}>
              {trimmedQuery ? `Results for "${trimmedQuery}"` : "Search Home"}
            </Text>
            <Text style={styles.searchOverviewSubtitle}>{resultSummary}</Text>
          </View>
        </View>

        <View style={styles.searchMetricsRow}>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>{peopleResults.length}</Text>
            <Text style={styles.searchMetricLabel}>People</Text>
          </View>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>{contentResults.length}</Text>
            <Text style={styles.searchMetricLabel}>Posts & polls</Text>
          </View>
          <View style={styles.searchMetricChip}>
            <Text style={styles.searchMetricValue}>
              {dateFilter === "all" ? "Any" : dateFilter}
            </Text>
            <Text style={styles.searchMetricLabel}>Date</Text>
          </View>
        </View>

        <View style={[styles.quickFiltersRow, styles.quickFiltersContainer]}>
          {SEARCH_TABS.map((option) => (
            <TouchableOpacity
              key={option.key}
              style={[
                styles.quickFilterChip,
                tab === option.key && styles.quickFilterChipActive,
              ]}
              onPress={() => pressTab(option.key)}
              activeOpacity={0.9}
            >
              <Text
                style={[
                  styles.quickFilterText,
                  tab === option.key && styles.quickFilterTextActive,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.quickFiltersRow}>
          {DATE_FILTERS.map((option) => (
            <TouchableOpacity
              key={option.key}
              style={[
                styles.timeChip,
                dateFilter === option.key && styles.timeChipActive,
              ]}
              onPress={() => pressDateFilter(option.key)}
              activeOpacity={0.9}
            >
              <Text
                style={[
                  styles.timeChipText,
                  dateFilter === option.key && styles.timeChipTextActive,
                ]}
              >
                {option.label}
              </Text>
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            style={[styles.timeChip, styles.sortChip]}
            onPress={toggleSort}
            activeOpacity={0.9}
          >
            <Ionicons name="swap-vertical" size={14} color="#8f6a60" />
            <Text style={styles.timeChipText}>
              {sort === "relevance"
                ? "Best match"
                : sort === "newest"
                  ? "Newest first"
                  : "Oldest first"}
            </Text>
          </TouchableOpacity>
        </View>

        {results.length === 0 ? (
          <View style={styles.emptySearchState}>
            <Ionicons name="search-outline" size={58} color="#d4b8a8" />
            <Text style={styles.emptyTitle}>No results found</Text>
            <Text style={styles.emptySubtitle}>
              Try a different keyword or widen the date filter.
            </Text>
          </View>
        ) : (
          <>
            {showPeopleSection && peopleResults.length > 0 && (
              <View style={styles.searchSection}>
                <View style={styles.searchSectionHeader}>
                  <View style={styles.searchSectionIcon}>
                    <Ionicons name="people" size={18} color="#5f0909" />
                  </View>
                  <View style={styles.searchSectionCopy}>
                    <Text style={styles.searchSectionTitle}>People</Text>
                    <Text style={styles.searchSectionSubtitle}>
                      Profiles that closely match your search.
                    </Text>
                  </View>
                </View>

                {peopleResults.map((result) => (
                  <TouchableOpacity
                    key={result.id}
                    style={styles.personResultCard}
                    onPress={() => pressResult(result)}
                    activeOpacity={0.88}
                  >
                    <View style={styles.personAvatar}>
                      {result.avatarUri ? (
                        <Image
                          source={{ uri: avatarThumb(result.avatarUri, 96) }}
                          style={styles.personAvatarImage}
                        />
                      ) : (
                        <Text style={styles.personAvatarText}>
                          {result.avatarLabel}
                        </Text>
                      )}
                    </View>
                    <View style={styles.personResultCopy}>
                      <Text style={styles.personResultTitle}>{result.title}</Text>
                      <Text style={styles.personResultSubtitle} numberOfLines={2}>
                        {result.subtitle}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color="#c47e6e" />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {showContentSection && matchedFeedItems.length > 0 && (
              <View style={styles.searchSection}>
                <View style={styles.searchSectionHeader}>
                  <View style={styles.searchSectionIcon}>
                    <Ionicons name="newspaper" size={18} color="#5f0909" />
                  </View>
                  <View style={styles.searchSectionCopy}>
                    <Text style={styles.searchSectionTitle}>Related Content</Text>
                    <Text style={styles.searchSectionSubtitle}>
                      Matching posts and polls from Home.
                    </Text>
                  </View>
                </View>

                {matchedFeedItems.map((item) => (
                  <View
                    key={`search-feed-${item.type}-${item.id}`}
                    style={styles.searchFeedCardWrap}
                  >
                    {renderFeedItem({ item })}
                  </View>
                ))}
              </View>
            )}

            {trimmedQuery ? (
              <View style={styles.searchTopicCard}>
                <Text style={styles.searchTopicTitle}>
                  Posts about {trimmedQuery}
                </Text>
                <Text style={styles.searchTopicSubtitle}>
                  {contentResults.length} related item
                  {contentResults.length === 1 ? "" : "s"} found on Home.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  headerIconButton: {
    justifyContent: "center",
    alignItems: "center",
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  headerSearchRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerSearchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff7f2",
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1.5,
    borderColor: "#e6c6b9",
    shadowColor: "#280404",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 3,
  },
  headerSearchInput: {
    flex: 1,
    color: "#3f1e1a",
    fontSize: 17,
    fontWeight: "500",
    marginLeft: 10,
    paddingVertical: 0,
  },
  searchCancelButton: {
    paddingHorizontal: 2,
    paddingVertical: 10,
  },
  searchCancelText: {
    color: "#f4dccc",
    fontSize: 16,
    fontWeight: "600",
  },
  searchDropdownCard: {
    position: "absolute",
    top: 8,
    left: 14,
    right: 14,
    backgroundColor: "#fffaf7",
    borderRadius: 24,
    padding: 14,
    borderWidth: 1.5,
    borderColor: "#ead8cd",
    shadowColor: "#2d0905",
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 14,
    zIndex: 30,
  },
  searchDropdownHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  searchDropdownTitle: {
    color: "#4d1b17",
    fontSize: 15.5,
    fontWeight: "800",
  },
  searchDropdownAction: {
    color: "#b45c4b",
    fontSize: 13.5,
    fontWeight: "700",
  },
  searchSuggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 6,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#f1e4dc",
  },
  searchSuggestionIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 14,
    backgroundColor: "#f9e4d7",
    alignItems: "center",
    justifyContent: "center",
  },
  searchSuggestionCopy: {
    flex: 1,
  },
  searchSuggestionTitle: {
    color: "#3f1e1a",
    fontSize: 15.5,
    fontWeight: "700",
  },
  searchSuggestionHint: {
    color: "#8d6a61",
    fontSize: 13,
    marginTop: 2,
  },
  searchDropdownEmpty: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 6,
    paddingVertical: 12,
  },
  searchDropdownEmptyText: {
    color: "#9c776d",
    fontSize: 14,
    fontWeight: "500",
  },
  searchScreen: {
    flex: 1,
  },
  searchScreenContent: {
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 140,
  },
  searchOverviewCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "#fff8f3",
    borderRadius: 24,
    padding: 16,
    borderWidth: 1.5,
    borderColor: "#efd9ca",
    marginBottom: 14,
  },
  searchOverviewIcon: {
    width: 42,
    height: 42,
    borderRadius: 15,
    backgroundColor: "#f8ddbf",
    alignItems: "center",
    justifyContent: "center",
  },
  searchOverviewCopy: {
    flex: 1,
  },
  searchOverviewTitle: {
    color: "#4a1712",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 3,
  },
  searchOverviewSubtitle: {
    color: "#86645a",
    fontSize: 14,
    lineHeight: 20,
  },
  searchMetricsRow: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  searchMetricChip: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "#ebddd4",
    alignItems: "center",
  },
  searchMetricValue: {
    color: "#5f0909",
    fontSize: 16,
    fontWeight: "800",
    textTransform: "capitalize",
  },
  searchMetricLabel: {
    color: "#9b766c",
    fontSize: 12.5,
    fontWeight: "600",
    marginTop: 3,
  },

  /* Filters */
  quickFiltersContainer: {
    marginBottom: 6,
  },
  quickFiltersRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingVertical: 4,
  },
  quickFilterChip: {
    flexGrow: 1,
    minWidth: "22%",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: "#fff",
    borderWidth: 1.5,
    borderColor: "#e8d9d0",
  },
  quickFilterChipActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  quickFilterText: {
    color: "#8c5f54",
    fontSize: 14.5,
    fontWeight: "600",
  },
  quickFilterTextActive: {
    color: "#f4e7df",
    fontWeight: "700",
  },
  timeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    backgroundColor: "#fffaf7",
    borderWidth: 1,
    borderColor: "#e8d9d0",
  },
  sortChip: {
    marginLeft: 0,
  },
  timeChipActive: {
    backgroundColor: "#5f0909",
    borderColor: "#5f0909",
  },
  timeChipText: {
    color: "#8f6a60",
    fontSize: 13.5,
    fontWeight: "600",
  },
  timeChipTextActive: {
    color: "#f4e7df",
  },

  /* Results */
  searchSection: {
    marginTop: 14,
  },
  searchSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  searchSectionIcon: {
    width: 44,
    height: 44,
    borderRadius: 16,
    backgroundColor: "#f9dfc8",
    alignItems: "center",
    justifyContent: "center",
  },
  searchSectionCopy: {
    flex: 1,
  },
  searchSectionTitle: {
    color: "#4d1b17",
    fontSize: 16.5,
    fontWeight: "800",
  },
  searchSectionSubtitle: {
    color: "#967267",
    fontSize: 13.5,
    marginTop: 2,
  },
  personResultCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 22,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#efdfd6",
  },
  personAvatar: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: "#f4d7b1",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  personAvatarImage: {
    width: "100%",
    height: "100%",
  },
  personAvatarText: {
    color: "#5f0909",
    fontSize: 17,
    fontWeight: "800",
  },
  personResultCopy: {
    flex: 1,
    marginRight: 8,
  },
  personResultTitle: {
    color: "#381713",
    fontSize: 16,
    fontWeight: "700",
  },
  personResultSubtitle: {
    color: "#77574f",
    fontSize: 13.5,
    lineHeight: 19,
    marginTop: 3,
  },
  searchFeedCardWrap: {
    marginBottom: 12,
  },
  searchTopicCard: {
    backgroundColor: "#fffaf4",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1.5,
    borderColor: "#edd7b5",
    marginTop: 16,
  },
  searchTopicTitle: {
    color: "#4c1b14",
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 6,
  },
  searchTopicSubtitle: {
    color: "#87685f",
    fontSize: 14,
    lineHeight: 20,
  },
  emptySearchState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 56,
    paddingHorizontal: 26,
  },
  emptyTitle: {
    color: "#5f0909",
    fontSize: 18,
    fontWeight: "800",
    marginTop: 14,
    textAlign: "center",
  },
  emptySubtitle: {
    color: "#9b776d",
    fontSize: 14.5,
    lineHeight: 21,
    marginTop: 8,
    textAlign: "center",
  },

  // Covers the feed instead of replacing it, so closing search doesn't rebuild
  // every feed card or lose the reader's place in the feed.
  resultsOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#f8f3ef",
    zIndex: 25,
  },
});
