// contexts/ThemeContext.tsx
//
// Holds the chosen appearance and hands every screen the resolved palette.
//
// The choice is stored on the device rather than in Firestore on purpose:
// appearance belongs to the phone you are holding, not the account. Somebody
// who likes Midnight on their own phone should not have it follow them onto a
// shared library machine, and it must work before sign-in and while offline.
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useColorScheme } from "react-native";

import {
  DEFAULT_THEME,
  isThemeId,
  resolveTheme,
  THEMES,
  type ResolvedThemeId,
  type ThemeId,
  type ThemeTokens,
} from "@/utils/theme";

const STORAGE_KEY = "bonded.appearance";

type ThemeContextValue = {
  /** What the user picked, including "system". */
  choice: ThemeId;
  /** What that resolves to right now. */
  resolved: ResolvedThemeId;
  /** The palette to render with. */
  colors: ThemeTokens;
  setChoice: (next: ThemeId) => void;
  /** False until the stored choice has been read, to avoid a flash of light. */
  ready: boolean;
};

const ThemeContext = createContext<ThemeContextValue>({
  choice: DEFAULT_THEME,
  resolved: "light",
  colors: THEMES.light,
  setChoice: () => {},
  ready: false,
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeId>(DEFAULT_THEME);
  const [ready, setReady] = useState(false);

  // Read once on start. setState lands in the promise callback rather than
  // the effect body, which is what react-hooks/set-state-in-effect requires.
  useEffect(() => {
    let cancelled = false;

    AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (isThemeId(stored)) setChoiceState(stored);
        setReady(true);
      })
      .catch(() => {
        // A device that cannot read storage still gets a working app.
        if (!cancelled) setReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const setChoice = useCallback((next: ThemeId) => {
    // Applied immediately; the write is not awaited, because a slow disk
    // should never make tapping a theme feel unresponsive.
    setChoiceState(next);
    AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeContextValue>(() => {
    const resolved = resolveTheme(choice, systemScheme === "dark");
    return {
      choice,
      resolved,
      colors: THEMES[resolved],
      setChoice,
      ready,
    };
  }, [choice, ready, setChoice, systemScheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The palette and the current choice.
 *
 * Safe to call outside the provider — it falls back to the light palette, so
 * a screen rendered in isolation (a test, a storybook) still has colours.
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Shorthand for the common case of only needing the colours. */
export function useThemeColors(): ThemeTokens {
  return useContext(ThemeContext).colors;
}
