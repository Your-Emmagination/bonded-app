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
import { resolveUserRoleForAuthUser } from "@/utils/rbac";
import { Image } from "expo-image";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { onAuthStateChanged, User } from "firebase/auth";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { auth, db } from "../Firebase_configure";
import AppToast from "./(main)/components/AppToast";

export default function RootLayout() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const router = useRouter();
  const segments = useSegments();
  const hasNavigated = useRef(false);
  const lastHandledNotificationId = useRef<string | null>(null);
  const appActive = useAppActive();
  usePresenceHeartbeat(user);

  useEffect(() => {
    if (user?.uid && appActive) return subscribeToDirectMessageDelivery(user.uid);
  }, [user?.uid, appActive]);

  useEffect(() => {
    let isMounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!isMounted) return;
      setUser(currentUser);

      if (!currentUser) {
        hasNavigated.current = false;
        const currentSegment = segments[0] as string | undefined;
        if (
          currentSegment !== "LoginScreen" &&
          currentSegment !== "ForgotPasswordScreen"
        ) {
          router.replace("/LoginScreen");
        }
        setIsAuthChecking(false);
        return;
      }

      // User is logged in
      const inMainApp = segments[0] === "(main)";
      if (inMainApp) {
        setIsAuthChecking(false);
        return;
      }

      if (
        !hasNavigated.current ||
        segments[0] === "LoginScreen" ||
        segments[0] === undefined ||
        (segments[0] as string) === "index"
      ) {
        hasNavigated.current = true;
        try {
          // Resolving the role still warms the role cache before the first
          // screen mounts. Everyone now starts on Home — staff open the
          // Dashboard from its own tab.
          await resolveUserRoleForAuthUser(currentUser);
          if (!isMounted) return;

          router.replace("/(main)/(tabs)/HomeScreen");
        } catch (error) {
          console.error("Error resolving user role on startup:", error);
          if (isMounted) {
            router.replace("/(main)/(tabs)/HomeScreen");
          }
        } finally {
          if (isMounted) {
            setTimeout(() => {
              if (isMounted) setIsAuthChecking(false);
            }, 100);
          }
        }
      } else {
        setIsAuthChecking(false);
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [router, segments]);

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

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={isAuthChecking ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          gestureEnabled: false,
          animation: "fade",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="LoginScreen" />
        <Stack.Screen name="ForgotPasswordScreen" />
        <Stack.Screen name="(main)" />
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
          <Image
            source={require("../assets/images/BondEDlogo.png")}
            style={{ width: 140, height: 140 }}
            contentFit="contain"
          />
          <ActivityIndicator size="small" color="#e0a53d" style={{ marginTop: 24 }} />
        </View>
      )}
    </GestureHandlerRootView>
  );
}
