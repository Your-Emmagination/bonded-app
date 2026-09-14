import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useMemo, useState } from "react";
import {
    ScrollView,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Audience = "global" | "server";

type LiveStreamRouteParams = {
  serverId?: string | string[];
  serverName?: string | string[];
  channelId?: string | string[];
  channelLabel?: string | string[];
};

const getSingleParam = (value?: string | string[]) =>
  Array.isArray(value) ? value[0] : value;

export default function LiveStreamScreen() {
  const { styles, theme } = useStyles();
  const { serverId, serverName, channelLabel } =
    useLocalSearchParams<LiveStreamRouteParams>();
  const navigation = useNavigation();
  const resolvedServerId = getSingleParam(serverId) || "";
  const resolvedServerName = getSingleParam(serverName) || "";
  const resolvedChannelLabel = getSingleParam(channelLabel) || "";
  const hasServerContext = Boolean(resolvedServerId);

  const [audience, setAudience] = useState<Audience>(
    hasServerContext ? "server" : "global",
  );

  const audienceLabel = useMemo(() => {
    if (audience === "server" && resolvedServerName) {
      return resolvedChannelLabel
        ? `${resolvedServerName} #${resolvedChannelLabel}`
        : resolvedServerName;
    }
    return "Home feed";
  }, [audience, resolvedChannelLabel, resolvedServerName]);

  const handleBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconButton} onPress={handleBack}>
          <Ionicons name="arrow-back" size={23} color={theme.primary} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Live Stream</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.messageCard}>
          <Text style={styles.messageTitle}>Live Streaming Removed</Text>
          <Text style={styles.messageText}>
            The live streaming feature has been removed from this app.
            Continue using the rest of the application as normal.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Current audience</Text>
          <Text style={styles.value}>{audience === "server" ? "Group" : "Home"}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.label}>Audience mode</Text>
          <View style={styles.segmentRow}>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                audience === "global" && styles.segmentButtonActive,
              ]}
              onPress={() => setAudience("global")}
            >
              <Ionicons
                name="home-outline"
                size={18}
                color={audience === "global" ? theme.onPrimary : theme.primary}
              />
              <Text
                style={[
                  styles.segmentText,
                  audience === "global" && styles.segmentTextActive,
                ]}
              >
                Home
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.segmentButton,
                audience === "server" && styles.segmentButtonActive,
                !hasServerContext && styles.segmentButtonDisabled,
              ]}
              onPress={() => setAudience("server")}
              disabled={!hasServerContext}
            >
              <Ionicons
                name="people-outline"
                size={18}
                color={audience === "server" ? theme.onPrimary : theme.primary}
              />
              <Text
                style={[
                  styles.segmentText,
                  audience === "server" && styles.segmentTextActive,
                ]}
              >
                Group
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={handleBack}>
          <Ionicons name="arrow-back-outline" size={21} color={theme.onChrome} />
          <Text style={styles.primaryButtonText}>Go Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: c.primary,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  iconButton: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: c.surface,
  },
  headerSpacer: {
    width: 32,
  },
  scroll: {
    flex: 1,
    paddingHorizontal: 16,
  },
  content: {
    paddingBottom: 24,
  },
  messageCard: {
    backgroundColor: c.surface,
    borderRadius: 16,
    padding: 20,
    marginTop: 16,
  },
  messageTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: c.primary,
    marginBottom: 10,
  },
  messageText: {
    fontSize: 15,
    color: c.primary,
    lineHeight: 22,
  },
  section: {
    marginTop: 24,
  },
  label: {
    color: c.surface,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 10,
  },
  value: {
    color: c.surface,
    fontSize: 16,
    fontWeight: "600",
  },
  segmentRow: {
    flexDirection: "row",
    gap: 12,
  },
  segmentButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: c.surface,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  segmentButtonActive: {
    backgroundColor: c.surface,
  },
  segmentButtonDisabled: {
    opacity: 0.4,
  },
  segmentText: {
    color: c.surface,
    fontSize: 14,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: c.primary,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: c.primary,
    borderColor: c.surface,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 28,
  },
  primaryButtonText: {
    color: c.surface,
    fontSize: 16,
    fontWeight: "700",
  },
});

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};
