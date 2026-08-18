// app/(main)/_layout.tsx
import React from "react";
import { Stack } from "expo-router";

export default function MainLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: true,
        animation: "fade",
        contentStyle: { backgroundColor: "#f6f1ed" },
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="CreatePostScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="CreatePollScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="CreateEventScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="LiveStreamScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="EventCalendarScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="UserProfileScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="BookmarksScreen"
        options={{
          animation: "fade",
          contentStyle: { backgroundColor: "#f6f1ed" },
        }}
      />
      <Stack.Screen
        name="ReportManagementScreen"
        options={{
          animation: "fade_from_bottom",
          contentStyle: { backgroundColor: "#f6f1ed" },
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
