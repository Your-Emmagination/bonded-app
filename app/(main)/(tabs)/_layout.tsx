// (tabs)/_layout.tsx
import React, { useEffect, useRef, useState } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  Animated,
  Platform,
  TouchableOpacity,
  Text,
  View,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";

const SCREEN_WIDTH = Dimensions.get("window").width;

function TabItem({ isFocused, color, iconName, label, onPress }: any) {
  const fadeAnim = useRef(new Animated.Value(isFocused ? 1 : 0)).current;
  const scaleAnim = useRef(new Animated.Value(isFocused ? 1.05 : 1)).current;

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
          width: SCREEN_WIDTH / 5,
          height: 50,
          borderRadius: 12,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: isFocused
            ? "rgba(255, 59, 127, 0.15)"
            : "transparent",
          transform: [{ scale: scaleAnim }],
          opacity: fadeAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [0.5, 1],
          }),
        }}
      >
        <Ionicons name={iconName} size={24} color={color} />
        <Text
          numberOfLines={1}
          ellipsizeMode="tail"
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

export default function TabLayout() {
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadRole = async () => {
      try {
        const storedRole = await AsyncStorage.getItem("userRole");
        setUserRole(storedRole?.toLowerCase() || "student");
      } catch (error) {
        console.error("Error reading userRole:", error);
        setUserRole("student");
      } finally {
        setLoading(false);
      }
    };

    loadRole();
  }, []);

  if (loading) {
    return null;
  }

  const dashboardRoles = ["moderator", "teacher", "admin"];
  const isDashboardUser = userRole ? dashboardRoles.includes(userRole) : false;

  const allRoutes = [
    { name: "HomeScreen", label: "Home", icon: "home" },
{ name: "NotificationsScreen", label: "Notifications", icon: "notifications" },    
{ name: "ProfileScreen", label: "Profile", icon: "person-circle" },
    { name: "DashboardScreen", label: "Dashboard", icon: "grid", visible: isDashboardUser },
  ];

  const visibleRoutes = allRoutes.filter((r) => r.visible !== false);

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: "#0f1624",
      }}
      edges={["bottom"]}
    >
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarStyle: { display: "none" },
        }}
        tabBar={({ state, navigation }) => (
          <View
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              flexDirection: "row",
              justifyContent: "space-around",
              alignItems: "center",
              backgroundColor: "#0f1624",
              borderTopWidth: 1,
              borderTopColor: "#ff3b7f",
              height: 70,
              paddingBottom: Platform.OS === "android" ? 5 : 15,
            }}
          >
            {state.routes.map((route: any, index: number) => {
              const isFocused = state.index === index;
              const routeInfo = visibleRoutes.find((r) => r.name === route.name);
              const color = isFocused ? "#ff3b7f" : "#777";

              if (!routeInfo) return null;

              const onPress = () => {
                const event = navigation.emit({
                  type: "tabPress",
                  target: route.key,
                  canPreventDefault: true,
                });
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
                  onPress={onPress}
                />
              );
            })}
          </View>
        )}
      >
        <Tabs.Screen name="HomeScreen" />
        <Tabs.Screen name="NotificationsScreen" />
        <Tabs.Screen name="ProfileScreen" />
        <Tabs.Screen name="DashboardScreen" />
      </Tabs>
    </SafeAreaView>
  );
}