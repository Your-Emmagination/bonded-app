import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { ListSkeleton } from "./components/Skeleton";
import { auth } from "../../Firebase_configure";
import { subscribeToMyTicketBadge } from "@/utils/supportTickets";
import { useTheme } from "@/contexts/ThemeContext";
import {
  THEME_OPTIONS,
  type ThemeId,
  type ThemeOption,
  type ThemeTokens,
} from "@/utils/theme";
import {
  fetchNotificationSoundId,
  setNotificationSoundId,
} from "../../utils/notificationSettings";
import {
  NOTIFICATION_SOUND_OPTIONS,
  NotificationSoundId,
} from "../../utils/notificationSounds";
import {
  isPushNotificationsSupported,
  registerDeviceForPushNotifications,
} from "../../utils/pushNotifications";

const THEME_GROUPS: { key: ThemeOption["group"]; label: string }[] = [
  { key: "brightness", label: "LIGHT & DARK" },
  { key: "campus", label: "CAMPUS COLOURS" },
];

/**
 * One theme in the Appearance grid: three dots of its own colours, its name,
 * and a check once chosen. Picking one recolours the whole screen at once,
 * so the card itself gives a small settle and the check fades in — enough to
 * show which tap took, without animating the app.
 */
const ThemeChoiceCard = React.memo(function ThemeChoiceCard({
  option,
  selected,
  onSelect,
  styles,
  theme,
}: {
  option: ThemeOption;
  selected: boolean;
  onSelect: (id: ThemeId) => void;
  styles: ReturnType<typeof makeStyles>;
  theme: ThemeTokens;
}) {
  const settle = useSharedValue(1);
  const check = useSharedValue(selected ? 1 : 0);
  const firstRunRef = useRef(true);
  useEffect(() => {
    check.value = withTiming(selected ? 1 : 0, { duration: 180 });
    // Not on first show: only a card that has just been picked settles.
    if (selected && !firstRunRef.current) {
      settle.value = withSequence(
        withTiming(0.98, { duration: 70 }),
        withTiming(1, { duration: 150 }),
      );
    }
    firstRunRef.current = false;
  }, [check, selected, settle]);

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ scale: settle.value }] }));
  const checkStyle = useAnimatedStyle(() => ({
    opacity: check.value,
    transform: [{ scale: 0.6 + 0.4 * check.value }],
  }));

  return (
    <Reanimated.View style={[styles.themeCardWrap, cardStyle]}>
      <Pressable
        onPress={() => onSelect(option.id)}
        style={({ pressed }) => [
          styles.themeCard,
          selected && styles.themeCardSelected,
          pressed && styles.themeCardPressed,
        ]}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={`${option.label}. ${option.description}`}
      >
        <View style={styles.themeCardTop}>
          {/* The palette's own colours: a name alone doesn't say what
              "Dim" or "Campus Teal" looks like. */}
          <View style={styles.themeDots}>
            {option.swatch.map((shade, index) => (
              <View
                key={`${option.id}-${index}`}
                style={[
                  styles.themeDot,
                  index > 0 && styles.themeDotOverlap,
                  { backgroundColor: shade },
                ]}
              />
            ))}
          </View>
          <Reanimated.View style={checkStyle}>
            <Ionicons name="checkmark-circle" size={20} color={theme.primary} />
          </Reanimated.View>
        </View>
        <Text style={styles.themeCardLabel} numberOfLines={1}>
          {option.label}
        </Text>
        <Text style={styles.themeCardDesc} numberOfLines={2}>
          {option.description}
        </Text>
      </Pressable>
    </Reanimated.View>
  );
});

const SettingsScreen = () => {
  const router = useRouter();
  const [soundId, setSoundId] = useState<NotificationSoundId | null>(null);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<NotificationSoundId | null>(null);
  const activePlayerRef = useRef<AudioPlayer | null>(null);
  // Support replies waiting to be read. Shown as a badge on the row so a
  // student who never thinks to check finds out anyway.
  const [supportUnread, setSupportUnread] = useState(0);
  const {
    choice: themeChoice,
    resolved: resolvedTheme,
    setChoice: setThemeChoice,
    colors: theme,
  } = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) return;
    return subscribeToMyTicketBadge(user.uid, setSupportUnread);
  }, []);

  useEffect(() => {
    const user = auth.currentUser;
    if (!user) {
      setLoading(false);
      return;
    }

    fetchNotificationSoundId(user.uid)
      .then(setSoundId)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    return () => {
      activePlayerRef.current?.remove();
    };
  }, []);

  const playPreview = useCallback((assetModule: number | null) => {
    if (!assetModule) return;

    activePlayerRef.current?.remove();
    const player = createAudioPlayer(assetModule);
    activePlayerRef.current = player;
    player.play();
  }, []);

  const handleSelectSound = useCallback(
    async (id: NotificationSoundId, previewAsset: number | null) => {
      playPreview(previewAsset);

      const user = auth.currentUser;
      if (!user) return;

      const previous = soundId;
      setSoundId(id);
      setSavingId(id);

      try {
        await setNotificationSoundId(user.uid, id);

        if (id !== "silent" && isPushNotificationsSupported()) {
          await registerDeviceForPushNotifications(user);
        }
      } catch (error) {
        console.error("Error saving notification sound:", error);
        setSoundId(previous);
      } finally {
        setSavingId(null);
      }
    },
    [playPreview, soundId],
  );

  const handleTogglePush = useCallback(async (value: boolean) => {
    setPushEnabled(value);
    const user = auth.currentUser;
    if (!user || !value || !isPushNotificationsSupported()) return;
    await registerDeviceForPushNotifications(user).catch((error) =>
      console.error("Error registering for push notifications:", error),
    );
  }, []);

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.background }]}
      edges={["top"]}
    >
      <View style={[styles.headerBar, { backgroundColor: theme.primary }]}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color={theme.onChrome} />
        </TouchableOpacity>
        <Text style={[styles.header, { color: theme.onChrome }]}>Settings</Text>
        <View style={{ width: 32 }} />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      {/* First section on purpose: it is the setting people come looking for,
          and every choice below is previewed live as you tap it. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>APPEARANCE</Text>
        <Text style={styles.sectionHint}>
          {themeChoice === "system"
            ? `Following your phone — currently ${resolvedTheme === "light" ? "light" : "dark"}`
            : "Applies to this device only"}
        </Text>

        {THEME_GROUPS.map((group) => (
          <View key={group.key} accessibilityRole="radiogroup">
            <Text style={styles.themeGroupLabel}>{group.label}</Text>
            <View style={styles.themeGrid}>
              {THEME_OPTIONS.filter((option) => option.group === group.key).map((option) => (
                <ThemeChoiceCard
                  key={option.id}
                  option={option}
                  selected={themeChoice === option.id}
                  onSelect={setThemeChoice}
                  styles={styles}
                  theme={theme}
                />
              ))}
            </View>
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>ACCOUNT</Text>
        <View style={styles.goldCard}>
          {/* Both rows open the same screen; Change Password just lands on
              its tab. It used to bounce through the Profile tab, which left
              "back" on Profile instead of here. */}
          <TouchableOpacity accessibilityRole="button" style={styles.soundRow} onPress={() => router.push("/(main)/EditProfileScreen" as any)}>
            <View style={styles.iconBox}><Ionicons name="person-circle-outline" size={18} color={theme.primary} /></View>
            <View style={{ marginLeft: 12, flex: 1 }}><Text style={styles.rowLabel}>Edit Profile</Text><Text style={styles.rowSubtext}>Personal email and profile photo</Text></View>
            <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
          </TouchableOpacity>
          <View style={styles.rowDivider} />
          <TouchableOpacity accessibilityRole="button" style={styles.soundRow} onPress={() => router.push({ pathname: "/(main)/EditProfileScreen", params: { tab: "password" } } as any)}>
            <View style={styles.iconBox}><Ionicons name="lock-closed-outline" size={18} color={theme.primary} /></View>
            <View style={{ marginLeft: 12, flex: 1 }}><Text style={styles.rowLabel}>Change Password</Text><Text style={styles.rowSubtext}>Update your password whenever you need to</Text></View>
            <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Support sits here rather than in the Profile action list: it is not
          another thing about you, it is where you go when something breaks.
          A waiting reply is surfaced loudly, though — burying the entry point
          is fine, burying the answer is not. */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>HELP &amp; SUPPORT</Text>
        <View style={styles.goldCard}>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.soundRow}
            onPress={() => router.push("/(main)/SupportScreen" as any)}
          >
            <View style={styles.iconBox}>
              <Ionicons name="help-buoy-outline" size={18} color={theme.primary} />
            </View>
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={styles.rowLabel}>Help &amp; Support</Text>
              <Text style={styles.rowSubtext}>
                Report a problem or check a request you sent
              </Text>
            </View>
            {supportUnread > 0 && (
              <View style={styles.supportBadge}>
                <Text style={styles.supportBadgeText}>{supportUnread}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color={theme.textMuted} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>PUSH NOTIFICATIONS</Text>
        <View style={styles.goldCard}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Enable Push Notifications</Text>
              <Text style={styles.rowSubtext}>
                Get notified about likes, comments, and mentions
              </Text>
            </View>
            <Switch
              value={pushEnabled}
              onValueChange={handleTogglePush}
              trackColor={{ false: theme.borderStrong, true: theme.accent }}
              thumbColor={theme.surfaceRaised}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>NOTIFICATION SOUND</Text>
        <Text style={styles.sectionHint}>
          Tap a sound to preview and set it as your default
        </Text>

        {loading ? (
          <ListSkeleton count={4} lines={1} contentStyle={styles.skeletonCard} />
        ) : (
          <View style={styles.goldCard}>
            {NOTIFICATION_SOUND_OPTIONS.map((option, index) => {
              const isSelected = soundId
                ? soundId === option.id
                : option.id === "default";
              const isSaving = savingId === option.id;

              return (
                <View key={option.id}>
                  <TouchableOpacity
                    style={styles.soundRow}
                    activeOpacity={0.7}
                    onPress={() =>
                      handleSelectSound(option.id, option.previewAsset)
                    }
                  >
                    <View style={styles.iconBox}>
                      <Ionicons
                        name={
                          option.id === "silent"
                            ? "volume-mute-outline"
                            : "musical-notes-outline"
                        }
                        size={18}
                        color={theme.primary}
                      />
                    </View>
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text style={styles.rowLabel}>{option.label}</Text>
                      <Text style={styles.rowSubtext}>
                        {option.description}
                      </Text>
                    </View>
                    {isSaving ? (
                      <ActivityIndicator color={theme.accent} size="small" />
                    ) : isSelected ? (
                      <Ionicons
                        name="checkmark-circle"
                        size={22}
                        color={theme.accent}
                      />
                    ) : (
                      <View style={styles.unselectedCircle} />
                    )}
                  </TouchableOpacity>
                  {index < NOTIFICATION_SOUND_OPTIONS.length - 1 && (
                    <View style={styles.rowDivider} />
                  )}
                </View>
              );
            })}
          </View>
        )}

        {Platform.OS === "ios" && (
          <Text style={styles.iosNote}>
            iOS may cache the previous sound briefly after your first change
            — it updates on the next app relaunch if it doesn't right away.
          </Text>
        )}
      </View>
      </ScrollView>
    </SafeAreaView>
  );
};

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: c.chrome,
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  backBtn: { width: 32, alignItems: "flex-start" },
  header: { color: c.onChrome, fontSize: 18, fontWeight: "700" },
  section: { marginHorizontal: 16, marginTop: 20 },
  sectionTitle: {
    color: c.textSecondary,
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionHint: {
    color: c.textMuted,
    fontSize: 12,
    marginBottom: 8,
    marginTop: -4,
  },
  skeletonCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: c.accent,
    paddingVertical: 6,
    marginTop: 4,
  },
  goldCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: c.accent,
    paddingHorizontal: 14,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 5,
    elevation: 3,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
  },
  soundRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
  },
  rowDivider: { height: 1, backgroundColor: c.border },
  themeGroupLabel: {
    color: c.textMuted,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.6,
    marginTop: 6,
    marginBottom: 8,
  },
  themeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 10,
    marginBottom: 8,
  },
  themeCardWrap: { width: "48.5%" },
  themeCard: {
    minHeight: 96,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  // Chosen: a heavier border in the identity colour and a faint tint, as well
  // as the check, so it doesn't rest on colour alone.
  themeCardSelected: {
    borderWidth: 2,
    borderColor: c.primary,
    backgroundColor: c.accentSoft,
  },
  themeCardPressed: { opacity: 0.85 },
  themeCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  themeDots: { flexDirection: "row", alignItems: "center" },
  themeDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: c.surface,
  },
  themeDotOverlap: { marginLeft: -6 },
  themeCardLabel: { color: c.textPrimary, fontSize: 13.5, fontWeight: "700" },
  themeCardDesc: { color: c.textMuted, fontSize: 11, lineHeight: 15, marginTop: 2 },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: c.surfaceSunken,
    justifyContent: "center",
    alignItems: "center",
  },
  rowLabel: { color: c.textPrimary, fontSize: 14, fontWeight: "600" },
  rowSubtext: { color: c.textMuted, fontSize: 11, marginTop: 2 },
  supportBadge: {
    minWidth: 21,
    height: 21,
    borderRadius: 999,
    backgroundColor: c.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
    marginRight: 6,
  },
  supportBadgeText: { color: c.onPrimary, fontSize: 11, fontWeight: "900" },
  unselectedCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: c.borderStrong,
  },
  iosNote: {
    color: c.textMuted,
    fontSize: 11,
    marginTop: 10,
    fontStyle: "italic",
  },
});

export default SettingsScreen;
