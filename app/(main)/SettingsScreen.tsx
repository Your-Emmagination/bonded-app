import { Ionicons } from "@expo/vector-icons";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth } from "../../Firebase_configure";
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

const SettingsScreen = () => {
  const router = useRouter();
  const [soundId, setSoundId] = useState<NotificationSoundId | null>(null);
  const [pushEnabled, setPushEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<NotificationSoundId | null>(null);
  const activePlayerRef = useRef<AudioPlayer | null>(null);

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
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={styles.headerBar}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
          hitSlop={10}
        >
          <Ionicons name="chevron-back" size={24} color="#fffaf7" />
        </TouchableOpacity>
        <Text style={styles.header}>Settings</Text>
        <View style={{ width: 32 }} />
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
              trackColor={{ false: "#e8d3b2", true: "#e0a53d" }}
              thumbColor="#fffaf7"
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
          <ActivityIndicator
            color="#5f0909"
            style={{ marginTop: 24 }}
          />
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
                        color="#5f0909"
                      />
                    </View>
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text style={styles.rowLabel}>{option.label}</Text>
                      <Text style={styles.rowSubtext}>
                        {option.description}
                      </Text>
                    </View>
                    {isSaving ? (
                      <ActivityIndicator color="#e0a53d" size="small" />
                    ) : isSelected ? (
                      <Ionicons
                        name="checkmark-circle"
                        size={22}
                        color="#e0a53d"
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
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f6f1ed" },
  headerBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#5f0909",
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  backBtn: { width: 32, alignItems: "flex-start" },
  header: { color: "#fffaf7", fontSize: 18, fontWeight: "700" },
  section: { marginHorizontal: 16, marginTop: 20 },
  sectionTitle: {
    color: "#5f0909",
    fontWeight: "700",
    fontSize: 12,
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  sectionHint: {
    color: "#9b766c",
    fontSize: 12,
    marginBottom: 8,
    marginTop: -4,
  },
  goldCard: {
    backgroundColor: "#fffaf7",
    borderRadius: 16,
    borderWidth: 2,
    borderColor: "#e0a53d",
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
  rowDivider: { height: 1, backgroundColor: "rgba(224,165,61,0.25)" },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#f0e7e2",
    justifyContent: "center",
    alignItems: "center",
  },
  rowLabel: { color: "#4d1b17", fontSize: 14, fontWeight: "600" },
  rowSubtext: { color: "#9b766c", fontSize: 11, marginTop: 2 },
  unselectedCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#e8d3b2",
  },
  iosNote: {
    color: "#9b766c",
    fontSize: 11,
    marginTop: 10,
    fontStyle: "italic",
  },
});

export default SettingsScreen;
