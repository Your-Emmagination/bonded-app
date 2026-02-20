// app/(main)/_layout.tsx
import { Stack } from "expo-router";

export default function MainLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        gestureEnabled: false,
        animation: "none",
        contentStyle: { backgroundColor: "#0f1624" },
      }}
    >
      <Stack.Screen
        name="(tabs)"
        options={{
          animation: "none",
          contentStyle: { backgroundColor: "#0f1624" },
        }}
      />
      <Stack.Screen
        name="CreatePostScreen"
        options={{ contentStyle: { backgroundColor: "#0e1320" } }}
      />
      <Stack.Screen
        name="CreatePollScreen"
        options={{ contentStyle: { backgroundColor: "#0f1624" } }}
      />
      <Stack.Screen
        name="CreateEventScreen"
        options={{ contentStyle: { backgroundColor: "#0f1624" } }}
      />
      <Stack.Screen
        name="EventCalendarScreen"
        options={{ contentStyle: { backgroundColor: "#0f1624" } }}
      />
      <Stack.Screen
        name="UserProfileScreen"
        options={{ contentStyle: { backgroundColor: "#0f1624" } }}
      />
    </Stack>
  );
}