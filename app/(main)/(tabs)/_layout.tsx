// app/(main)/(tabs)/_layout.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import { emitHomeFeedScrollToTop } from "@/utils/homeFeedEvents";
import { subscribeToUnreadNotificationCount } from "@/utils/notifications";
import { resolveUserRoleForAuthUser, subscribeToCurrentUserProfile } from "@/utils/rbac";
import { emitTabScrollToTop } from "@/utils/tabScrollEvents";
import { Ionicons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useRef, useState } from "react";
import {
    ActivityIndicator,
    Animated,
    Platform,
    Text,
    TouchableOpacity,
    View,
} from "react-native";
import Reanimated, {
    useAnimatedStyle,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth } from "../../../Firebase_configure";

function TabItem({
  isFocused,
  color,
  iconName,
  label,
  onPress,
  showBadge = false,
  badgeCount = 0,
}: any) {
  const theme = useThemeColors();
  const fadeAnim = useRef(new Animated.Value(isFocused ? 1 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(isFocused ? 1.05 : 1)).current;

  // Item 5: pop the unread badge only when the count actually goes up.
  const badgePop = useSharedValue(1);
  const prevBadgeCountRef = useRef<number>(badgeCount);
  useEffect(() => {
    if (badgeCount > prevBadgeCountRef.current) {
      badgePop.value = withSequence(
        withTiming(1.45, { duration: 120 }),
        withSpring(1, { damping: 8, stiffness: 380 }),
      );
    }
    prevBadgeCountRef.current = badgeCount;
  }, [badgeCount, badgePop]);
  const badgeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: badgePop.value }],
  }));

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, {
        toValue: isFocused ? 1 : 0,
        duration: 150,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: isFocused ? 1.05 : 1,
        friction: 6,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fadeAnim, isFocused, scaleAnim]);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        height: 70,
      }}
    >
      <Animated.View
        style={{
          width: "100%",
          height: 50,
          borderRadius: 12,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: isFocused ? theme.accentSoft : "transparent",
          transform: [{ scale: scaleAnim }],
          opacity: fadeAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.5, 1],
          }),
        }}
      >
        <View style={{ position: "relative" }}>
          <Ionicons name={iconName} size={24} color={color} />
          {showBadge && (
            <Reanimated.View
              style={[
                styles.notificationBadge,
                { backgroundColor: theme.accent, borderColor: theme.chrome },
                badgeStyle,
              ]}
            />
          )}
        </View>

        <Text
          numberOfLines={1}
          style={{
            color,
            fontSize: 11,
            marginTop: 3,
            textAlign: "center",
          }}
        >
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Defines visible tabs per role — order here = visual order in tab bar
const studentRoutes = [
  { name: "HomeScreen", label: "Home", icon: "home" },
  { name: "NotificationsScreen", label: "Notifications", icon: "notifications" },
  { name: "AiChatScreen", label: "B.E.A.", icon: "chatbubble-ellipses" },
  { name: "ProfileScreen", label: "Profile", icon: "person-circle" },
];

const privilegedRoutes = [
  { name: "HomeScreen", label: "Home", icon: "home" },
  { name: "NotificationsScreen", label: "Notifications", icon: "notifications" },
  { name: "AiChatScreen", label: "B.E.A.", icon: "chatbubble-ellipses" },
  { name: "ProfileScreen", label: "Profile", icon: "person-circle" },
  { name: "DashboardScreen", label: "Dashboard", icon: "grid" },
];

export default function TabLayout() {
  const theme = useThemeColors();
  const [userRole, setUserRole] = useState<string | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);

  useEffect(() => {
    let unsubscribeProfile: (() => void) | undefined;

    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      unsubscribeProfile?.();
      unsubscribeProfile = undefined;

      if (!user) {
        setAuthUserId(null);
        setUserRole("student");
        return;
      }

      setAuthUserId(user.uid);
      const role = await resolveUserRoleForAuthUser(user);
      setUserRole(role?.toLowerCase() || "student");

      // An admin can change this account's role at any moment. onAuthStateChanged
      // only fires on sign-in, so without this the tab bar kept whatever role was
      // read then: a promotion never revealed its Dashboard, and a demotion went
      // on offering one the server would refuse.
      unsubscribeProfile = subscribeToCurrentUserProfile(user, (profile) => {
        if (profile?.role) {
          setUserRole(profile.role.toLowerCase());
        }
      });
    });

    return () => {
      unsubscribeProfile?.();
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    return subscribeToUnreadNotificationCount(authUserId, setUnreadNotificationCount);
  }, [authUserId]);

  if (userRole === null) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.chrome, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color={theme.accent} />
      </SafeAreaView>
    );
  }

  const isPrivileged = ["moderator", "teacher", "admin"].includes(userRole);
  const visibleRoutes = isPrivileged ? privilegedRoutes : studentRoutes;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.chrome }} edges={["bottom"]}>
      <Tabs
        screenOptions={{ headerShown: false, tabBarStyle: { display: "none" } }}
        initialRouteName="HomeScreen"
       tabBar={({ state, navigation }) => (
  <View
    style={{
      position: "absolute",
      bottom: 0,
      left: 0,
      right: 0,
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.chrome,
      borderTopWidth: 1,
      borderTopColor: theme.chromeBorder,
      height: 70,
      paddingBottom: Platform.OS === "android" ? 5 : 15,
    }}
  >
    {visibleRoutes.map((routeInfo) => {
      // Find the actual Expo Router route
      const routeIndex = state.routes.findIndex(
        (route) => route.name === routeInfo.name
      );

      if (routeIndex === -1) {
        return null;
      }

      const route = state.routes[routeIndex];

      // IMPORTANT:
      // Focus must be based on the real state.routes index,
      // not the visibleRoutes index.
      const isFocused = state.index === routeIndex;

      const color = isFocused ? theme.accent : theme.onChromeMuted;

      const onPress = () => {
        const event = navigation.emit({
          type: "tabPress",
          target: route.key,
          canPreventDefault: true,
        });

        if (route.name === "HomeScreen" && isFocused) {
          emitHomeFeedScrollToTop();
          return;
        }

        // Tapping the tab you're already on sends that screen back to the top.
        if (isFocused) {
          emitTabScrollToTop(route.name);
          return;
        }

        if (!isFocused && !event.defaultPrevented) {
          navigation.navigate(route.name);
        }
      };

      return (
        <TabItem
          key={route.key}
          isFocused={isFocused}
          color={color}
          iconName={routeInfo.icon}
          label={routeInfo.label}
          showBadge={
            route.name === "NotificationsScreen" &&
            unreadNotificationCount > 0
          }
          badgeCount={
            route.name === "NotificationsScreen" ? unreadNotificationCount : 0
          }
          onPress={onPress}
        />
      );
    })}
  </View>
)}
      >
        <Tabs.Screen name="HomeScreen" />

<Tabs.Screen name="NotificationsScreen" />

<Tabs.Screen name="AiChatScreen" />

<Tabs.Screen name="ProfileScreen" />

<Tabs.Screen
  name="DashboardScreen"
  options={!isPrivileged ? { href: null } : {}}
/>
      </Tabs>
    </SafeAreaView>
  );
}

const styles = {
  notificationBadge: {
    // Positioned relative to the 24px icon itself (its new parent, see
    // TabItem above) rather than the screen width — this stays correct
    // regardless of how many tabs are visible (4 for students, 5 for
    // staff), instead of assuming a fixed tab count.
    position: "absolute" as const,
    top: -2,
    right: -4,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
  },
};
