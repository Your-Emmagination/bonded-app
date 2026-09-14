// app/(main)/_layout.tsx
import { useThemeColors } from "@/contexts/ThemeContext";
import React from "react";
import { Stack } from "expo-router";

export default function MainLayout() {
  const theme = useThemeColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        animation: "fade",
        contentStyle: { backgroundColor: theme.surfaceSunken },
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="CreatePostScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="CreatePollScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="CreateEventScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="LiveStreamScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="EventCalendarScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="NotificationTargetScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="UserProfileScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="BookmarksScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="SettingsScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="ReportManagementScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="ManageCampusFaqScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="AnalyticsScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surfaceSunken },
        }}
      />
      <Stack.Screen
        name="MessagesScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: theme.surface },
        }}
      />
      <Stack.Screen
        name="DirectChatScreen"
        options={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: theme.surface },
        }}
      />
      <Stack.Screen
        name="ServerChannelScreen"
        options={{
          animation: "none",
          gestureEnabled: false,
          presentation: "transparentModal",
          contentStyle: { backgroundColor: "transparent" },
        }}
      />
    </Stack>
  );
}
