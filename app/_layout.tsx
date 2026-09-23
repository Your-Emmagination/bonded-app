// app/_layout.tsx
import { subscribeToDirectMessageDelivery } from "@/utils/directMessages";
import { useAppActive, usePresenceHeartbeat } from "@/utils/presence";
import {
    addPushNotificationResponseListener,
    getLastPushNotificationResponse,
    handlePushNotificationNavigation,
    isPushNotificationsSupported,
    playEmergencyAlertSound,
    registerDeviceForPushNotifications,
} from "@/utils/pushNotifications";
import { AccountSetupProvider, useAccountSetup } from "@/contexts/AccountSetupContext";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { resolveUserRoleForAuthUser } from "@/utils/rbac";
import { Image } from "expo-image";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useRef } from "react";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { db } from "../Firebase_configure";
import AppToast from "./(main)/components/AppToast";
import BrandWordmark from "./(main)/components/BrandWordmark";

export default function RootLayout() {
  // Outermost, so every screen and every modal can read the palette — and so
  // the stored choice is applied before the first screen paints.
  return (
    <ThemeProvider>
      {/* Reports the keyboard's position on every frame, so a typing bar can
          move with it rather than after it. Follows the app's edge-to-edge
          setup on its own, so screens look the same. */}
      <KeyboardProvider>
        <AccountSetupProvider>
          <RootNavigator />
        </AccountSetupProvider>
      </KeyboardProvider>
    </ThemeProvider>
  );
}

function RootNavigator() {
  const { user: accountUser, status } = useAccountSetup();
  const user = status === "ready" ? accountUser : null;
  const isAuthChecking = status === "loading";
  const router = useRouter();
  const segments = useSegments();
  const lastHandledNotificationId = useRef<string | null>(null);
  const appActive = useAppActive();
  const { colors } = useTheme();
  usePresenceHeartbeat(user);

  useEffect(() => {
    if (user?.uid && appActive) return subscribeToDirectMessageDelivery(user.uid);
  }, [user?.uid, appActive]);

  useEffect(() => {
    const route = segments[0] as string | undefined;
    if (status === "loading") return;
    if (status === "signed-out") {
      if (route !== "LoginScreen" && route !== "ForgotPasswordScreen" && route !== "SignInHelpScreen") {
        router.replace("/LoginScreen");
      }
    } else if (status === "setup" || status === "error") {
      if (route !== "ProfileSetupScreen") router.replace("/ProfileSetupScreen");
    } else if (route !== "(main)") {
      router.replace("/(main)/(tabs)/HomeScreen");
    }
  }, [router, segments, status]);

  useEffect(() => {
    lastHandledNotificationId.current = null;
    if (user) void resolveUserRoleForAuthUser(user);
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    if (!isPushNotificationsSupported()) {
      return;
    }

    registerDeviceForPushNotifications(user).catch((error) => {
      console.error("Error registering device for push notifications:", error);
    });
  }, [user]);

  useEffect(() => {
    if (!user?.uid) {
      return;
    }

    let hasLoadedInitialSnapshot = false;
    const emergencyNotificationsQuery = query(
      collection(db, "notifications"),
      where("recipientId", "==", user.uid),
      where("type", "==", "emergency"),
    );

    const unsubscribe = onSnapshot(
      emergencyNotificationsQuery,
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type !== "added") {
            return;
          }

          if (!hasLoadedInitialSnapshot) {
            return;
          }

          const data = change.doc.data();
          if (data?.read === true) {
            return;
          }

          const actorName =
            typeof data?.actorName === "string" && data.actorName.trim()
              ? data.actorName.trim()
              : "BondED";
          const message =
            typeof data?.message === "string" && data.message.trim()
              ? data.message.trim()
              : "sent an emergency alert";
          const preview =
            typeof data?.preview === "string" && data.preview.trim()
              ? data.preview.trim()
              : "Open BondED for details.";

          playEmergencyAlertSound({
            title: "Emergency alert",
            body: `${actorName} ${message}: ${preview}`,
            data: {
              entityId: change.doc.id,
              parentId:
                typeof data?.parentId === "string" ? data.parentId : "",
            },
          }).catch((error) => {
            console.error("Error playing emergency alert sound:", error);
          });
        });

        hasLoadedInitialSnapshot = true;
      },
      (error) => {
        console.error("Error listening for emergency notifications:", error);
      },
    );

    return unsubscribe;
  }, [user?.uid]);

  useEffect(() => {
    if (!user || !isPushNotificationsSupported()) {
      return;
    }

    let isActive = true;
    let subscription: { remove: () => void } | null = null;

    const handleResponse = (response: unknown) => {
      const typedResponse = response as
        | {
            notification?: {
              request?: { identifier?: string };
            };
          }
        | null
        | undefined;
      const notificationId = typedResponse?.notification?.request?.identifier;

      if (!notificationId || lastHandledNotificationId.current === notificationId) {
        return;
      }

      const wasHandled = handlePushNotificationNavigation(
        response as Parameters<typeof handlePushNotificationNavigation>[0],
        router,
      );
      if (wasHandled) {
        lastHandledNotificationId.current = notificationId;
      }
    };

    getLastPushNotificationResponse()
      .then((response) => {
        if (isActive) {
          handleResponse(response);
        }
      })
      .catch((error) => {
        console.error("Error reading last notification response:", error);
      });

    addPushNotificationResponseListener((response) => {
      if (isActive) {
        handleResponse(response);
      }
    })
      .then((nextSubscription) => {
        if (!isActive) {
          nextSubscription?.remove();
          return;
        }

        subscription = nextSubscription;
      })
      .catch((error) => {
        console.error("Error attaching notification response listener:", error);
      });

    return () => {
      isActive = false;
      subscription?.remove();
    };
  }, [router, user]);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* The splash is always the dark maroon, so its bar stays light
          regardless of appearance; after that the palette decides. */}
      <StatusBar style={isAuthChecking ? "light" : colors.statusBarStyle} />
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
          animation: "fade",
          // Shows for a moment behind a screen as it fades in, so it follows
          // the palette (it is Light's own sunken tone, so Light is unchanged).
          contentStyle: { backgroundColor: colors.surfaceSunken },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Protected guard={status === "signed-out"}>
          <Stack.Screen name="LoginScreen" />
          <Stack.Screen name="ForgotPasswordScreen" />
          <Stack.Screen name="SignInHelpScreen" />
        </Stack.Protected>
        <Stack.Protected guard={status === "setup" || status === "error"}>
          <Stack.Screen name="ProfileSetupScreen" />
        </Stack.Protected>
        <Stack.Protected guard={status === "ready"}>
          <Stack.Screen name="(main)" />
        </Stack.Protected>
      </Stack>

      <AppToast />

      {isAuthChecking && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              justifyContent: "center",
              alignItems: "center",
              backgroundColor: "#5f0909",
              zIndex: 99999,
            },
          ]}
        >
          {/* The mark alone now — the name is text, so it reads on maroon. */}
          <Image
            source={require("../assets/images/BondEDlogo.png")}
            style={{ width: 112, height: 112 }}
            contentFit="contain"
          />
          <BrandWordmark size={24} style={{ marginTop: 12 }} />
          <ActivityIndicator size="small" color="#e0a53d" style={{ marginTop: 24 }} />
        </View>
      )}
    </GestureHandlerRootView>
  );
}
