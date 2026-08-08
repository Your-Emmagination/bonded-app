// app/_layout.tsx
import React from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { resolveUserRoleForAuthUser } from "@/utils/rbac";
import {
  addPushNotificationResponseListener,
  getLastPushNotificationResponse,
  handlePushNotificationNavigation,
  isPushNotificationsSupported,
  playEmergencyAlertSound,
  registerDeviceForPushNotifications,
} from "@/utils/pushNotifications";

export default function RootLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const router = useRouter();
  const segments = useSegments();
  const hasNavigated = useRef(false);
  const lastHandledNotificationId = useRef<string | null>(null);

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

      resolveUserRoleForAuthUser(user).then((role) => {
        const normalizedRole = role?.toLowerCase() || "student";
        const isPrivileged = ["moderator", "teacher", "admin"].includes(normalizedRole);

        if (isPrivileged) {
          router.replace("/(main)/(tabs)/DashboardScreen");
        } else {
          router.replace("/(main)/(tabs)/HomeScreen");
        }
      });
    }
  }, [user, segments, router]);

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
    if (!isPushNotificationsSupported()) {
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
  }, [router]);

  if (user === undefined) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#f6f1ed" }}>
          <StatusBar style="dark" backgroundColor="#f6f1ed" />
          <ActivityIndicator size="large" color="#e0a53d" />
        </View>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="dark" backgroundColor="#f6f1ed" />
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
          animation: "fade",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      >
        <Stack.Screen name="LoginScreen" />
        <Stack.Screen name="(main)" />
      </Stack>
    </GestureHandlerRootView>
  );
}
