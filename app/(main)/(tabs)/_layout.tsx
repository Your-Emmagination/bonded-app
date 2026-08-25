// app/(main)/(tabs)/_layout.tsx
import React, { useEffect, useRef, useState } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { onAuthStateChanged } from "firebase/auth";
import { emitHomeFeedScrollToTop } from "@/utils/homeFeedEvents";
import { auth } from "../../../Firebase_configure";
import { subscribeToUnreadNotificationCount } from "@/utils/notifications";
import { resolveUserRoleForAuthUser } from "@/utils/rbac";

const SCREEN_WIDTH = Dimensions.get("window").width;

function TabItem({
  isFocused,
  color,
  iconName,
  label,
  onPress,
  showBadge = false,
}: any) {
  const fadeAnim = useRef(new Animated.Value(isFocused ? 1 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(isFocused ? 1.05 : 1)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: isFocused ? 1 : 0, duration: 150, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: isFocused ? 1.05 : 1, friction: 6, useNativeDriver: true }),
    ]).start();
  }, [fadeAnim, isFocused, scaleAnim]);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.9}
      style={{ flex: 1, justifyContent: "center", alignItems: "center", height: 70 }}
    >
      <Animated.View
        style={{
          width: SCREEN_WIDTH / 4,
          height: 50,
          borderRadius: 12,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: isFocused ? "rgba(224, 165, 61, 0.22)" : "transparent",
          transform: [{ scale: scaleAnim }],
          opacity: fadeAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }),
        }}
      >
        <Ionicons name={iconName} size={24} color={color} />
        {showBadge && <View style={styles.notificationBadge} />}
        <Text numberOfLines={1} style={{ color, fontSize: 11, marginTop: 3, textAlign: "center" }}>
          {label}
        </Text>
      </Animated.View>
    </TouchableOpacity>
  );
}

// Defines visible tabs per role — order here = visual order in tab bar
const studentRoutes = [
  { name: "HomeScreen", label: "Home", icon: "home" },
  { name: "AiChatScreen", label: "AI", icon: "chatbubble-ellipses" },
  { name: "NotificationsScreen", label: "Notifications", icon: "notifications" },
  { name: "ProfileScreen", label: "Profile", icon: "person-circle" },
];

const privilegedRoutes = [
  { name: "DashboardScreen", label: "Dashboard", icon: "grid" },
  { name: "HomeScreen", label: "Home", icon: "home" },
  { name: "AiChatScreen", label: "AI", icon: "chatbubble-ellipses" },
  { name: "NotificationsScreen", label: "Notifications", icon: "notifications" },
  { name: "ProfileScreen", label: "Profile", icon: "person-circle" },
];

export default function TabLayout() {
  const [userRole, setUserRole] = useState<string | null>(null);
  const [authUserId, setAuthUserId] = useState<string | null>(null);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setAuthUserId(null);
        setUserRole("student");
        return;
      }

      setAuthUserId(user.uid);
      const role = await resolveUserRoleForAuthUser(user);
      setUserRole(role?.toLowerCase() || "student");
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    return subscribeToUnreadNotificationCount(authUserId, setUnreadNotificationCount);
  }, [authUserId]);

  if (userRole === null) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: "#5f0909", justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" color="#e0a53d" />
      </SafeAreaView>
    );
  }

  const isPrivileged = ["moderator", "teacher", "admin"].includes(userRole);
  const visibleRoutes = isPrivileged ? privilegedRoutes : studentRoutes;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#5f0909" }} edges={["bottom"]}>
      <Tabs
        screenOptions={{ headerShown: false, tabBarStyle: { display: "none" } }}
        initialRouteName={isPrivileged ? "DashboardScreen" : "HomeScreen"}
        tabBar={({ state, navigation }) => (
          <View style={{
            position: "absolute", bottom: 0, left: 0, right: 0,
            flexDirection: "row", justifyContent: "space-around", alignItems: "center",
            backgroundColor: "#5f0909", borderTopWidth: 1, borderTopColor: "#7f2220",
            height: 70, paddingBottom: Platform.OS === "android" ? 5 : 15,
          }}>
            {state.routes.map((route: any, index: number) => {
              const isFocused = state.index === index;
              const routeInfo = visibleRoutes.find((r) => r.name === route.name);
              if (!routeInfo) return null; 

              const color = isFocused ? "#e0a53d" : "#e7cdbf";
              const onPress = () => {
                const event = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (route.name === "HomeScreen" && isFocused) {
                  emitHomeFeedScrollToTop();
                  return;
                }
                if (!isFocused && !event.defaultPrevented) navigation.navigate(route.name);
              };

              return (
                <TabItem
                  key={route.key}
                  isFocused={isFocused}
                  color={color}
                  iconName={routeInfo.icon as any}
                  label={routeInfo.label}
                  showBadge={
                    route.name === "NotificationsScreen" && unreadNotificationCount > 0
                  }
                  onPress={onPress}
                />
              );
            })}
          </View>
        )}
      >
        <Tabs.Screen name="DashboardScreen" options={!isPrivileged ? { href: null } : {}} />
        <Tabs.Screen name="HomeScreen" />
        <Tabs.Screen name="AiChatScreen" />
        <Tabs.Screen name="NotificationsScreen" />
        <Tabs.Screen name="ProfileScreen" />
      </Tabs>
    </SafeAreaView>
  );
}

const styles = {
  notificationBadge: {
    position: "absolute" as const,
    top: 5,
    right: SCREEN_WIDTH / 8 - 4,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#ffcf5a",
    borderWidth: 2,
    borderColor: "#5f0909",
  },
};
