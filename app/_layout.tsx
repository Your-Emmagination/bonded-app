// app/_layout.tsx
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "../Firebase_configure";
import { ActivityIndicator, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export default function RootLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const router = useRouter();
  const segments = useSegments();
  const hasNavigated = useRef(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        hasNavigated.current = false;
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (user === undefined) return;

    const inMainApp = segments[0] === "(main)";
    const onLoginScreen =
      segments[0] === "LoginScreen" || segments[0] === undefined;

    if (inMainApp) return;

    if (!user && !onLoginScreen) {
      router.replace("/LoginScreen");
    } else if (user && onLoginScreen && !hasNavigated.current) {
      hasNavigated.current = true;

      AsyncStorage.getItem("userRole").then((role) => {
        const normalizedRole = role?.toLowerCase() || "student";
        const isPrivileged = ["moderator", "teacher", "admin"].includes(normalizedRole);

        // ✅ Always replace to HomeScreen — this puts (main) + (tabs) at the
        //    root of the stack. The tab layout handles showing Dashboard first
        //    for privileged users via initialRouteName.
        //    
        //    All other screens (CreatePostScreen, EventCalendarScreen, etc.) now
        //    live inside (main)/_layout.tsx's Stack, so pressing back from them
        //    correctly returns to the tab that triggered the navigation.
        if (isPrivileged) {
          router.replace("/(main)/(tabs)/HomeScreen");
          // Switch active tab to Dashboard without pushing a new stack entry
          router.navigate("/(main)/(tabs)/DashboardScreen");
        } else {
          router.replace("/(main)/(tabs)/HomeScreen");
        }
      });
    }
  }, [user, segments, router]);

  if (user === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0f1624" }}>
        <ActivityIndicator size="large" color="#ff3b7f" />
      </View>
    );
  }

  return (
    // This root Stack only has two entries: LoginScreen and (main).
    // All in-app navigation (tabs + pushed screens) is handled by
    // app/(main)/_layout.tsx — keeping back-navigation self-contained.
    <Stack screenOptions={{ headerShown: false, gestureEnabled: false }}>
      <Stack.Screen name="LoginScreen" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}