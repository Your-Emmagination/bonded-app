// app/_layout.tsx - OPTIMIZED VERSION
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useState, useRef } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { auth } from "../Firebase_configure";
import { ActivityIndicator,Platform , View } from "react-native";

export default function RootLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [initializing, setInitializing] = useState(true);
  const segments = useSegments();
  const router = useRouter();
const navigationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      console.log("Auth state changed:", currentUser ? "Logged in" : "Logged out");
      setUser(currentUser);
      setInitializing(false);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (initializing) return;

    // Clear any pending navigation
    if (navigationTimeoutRef.current) {
      clearTimeout(navigationTimeoutRef.current);
    }

    const inAuthGroup = segments[0] === "(main)";
    const isAuthenticated = !!user;

    console.log("Navigation check:", { inAuthGroup, isAuthenticated, segments });

    // Use timeout to prevent navigation during transitions
navigationTimeoutRef.current = setTimeout(() => {
  if (!isAuthenticated && inAuthGroup) {
    console.log("Redirecting to login (not authenticated)");
    router.replace("/LoginScreen");
  } else if (isAuthenticated && !inAuthGroup) {
    console.log("Redirecting to home (already authenticated)");
    router.replace("/(main)/(tabs)/HomeScreen");
  }
}, Platform.OS === "web" ? 300 : 50); // ← longer delay on web

    return () => {
      if (navigationTimeoutRef.current) {
        clearTimeout(navigationTimeoutRef.current);
      }
    };
  }, [user, segments, initializing, router]);

  if (initializing) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#0f1624" }}>
        <ActivityIndicator size="large" color="#ff3b7f" />
      </View>
    );
  }

  return (
    <Stack 
      screenOptions={{ 
        headerShown: false,
        animation: "fade", // Smoother transitions
        animationDuration: 200,
      }}
    >
      <Stack.Screen name="LoginScreen" />
      <Stack.Screen name="(main)" />
    </Stack>
  );
}