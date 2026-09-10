import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import type { User } from "firebase/auth";
import { collection, deleteField, doc, getDoc, onSnapshot, query, serverTimestamp, updateDoc, where } from "firebase/firestore";
import { auth, db } from "../Firebase_configure";
import { getStudentDocIdFromAuthUser } from "./rbac";
import { PRESENCE_TIMEOUT_MS, timestampMillis, type PresenceData } from "./messengerState";

const sessionId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
let offlinePublisher: (() => Promise<void>) | undefined;

export async function endPresenceSession() {
  await offlinePublisher?.();
}

export function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const refresh = () => setActive(AppState.currentState === "active" &&
      (Platform.OS !== "web" || typeof document === "undefined" || document.visibilityState !== "hidden"));
    refresh();
    const subscription = AppState.addEventListener("change", refresh);
    if (Platform.OS === "web" && typeof document !== "undefined") document.addEventListener("visibilitychange", refresh);
    return () => {
      subscription.remove();
      if (Platform.OS === "web" && typeof document !== "undefined") document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return active;
}

/** One writer at the app root. Each running app owns one session, so another
 * device going into the background does not make an active device disappear. */
export function usePresenceHeartbeat(user: User | null | undefined) {
  useEffect(() => {
    if (!user) return;
    let stopped = false;
    let connected = true;
    let profileRef: ReturnType<typeof doc> | null = null;
    let profile: PresenceData = {};
    let unsubscribeProfile: (() => void) | undefined;
    const visible = () => AppState.currentState === "active" &&
      (Platform.OS !== "web" || typeof document === "undefined" || document.visibilityState !== "hidden");
    const publish = (forceOffline = false) => {
      if (!profileRef || !connected || auth.currentUser?.uid !== user.uid) return Promise.resolve();
      const active = !forceOffline && visible() && profile.activeStatusEnabled !== false;
      const now = Date.now();
      const updates: Record<string, any> = {
        [`presenceSessions.${sessionId}`]: { isOnline: active, lastSeen: serverTimestamp() },
        isOnline: active || (profile.activeStatusEnabled !== false && Object.entries(profile.presenceSessions || {})
          .some(([id, session]) => id !== sessionId && session.isOnline && now - timestampMillis(session.lastSeen) < PRESENCE_TIMEOUT_MS)),
        lastSeen: serverTimestamp(),
      };
      // Keep the profile bounded without removing a recent session on another device.
      for (const [id, session] of Object.entries(profile.presenceSessions || {})) {
        if (id !== sessionId && now - timestampMillis(session.lastSeen) > 86_400_000) updates[`presenceSessions.${id}`] = deleteField();
      }
      return updateDoc(profileRef, updates).catch((error) => console.warn("[presence] Update failed:", error));
    };
    offlinePublisher = () => publish(true);
    const sync = () => { if (!stopped) void publish(); };
    const stateSubscription = AppState.addEventListener("change", sync);
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      connected = state.isConnected !== false && state.isInternetReachable !== false;
      if (connected) sync(); // Lost connections expire using the last successful heartbeat.
    });
    if (Platform.OS === "web" && typeof document !== "undefined") document.addEventListener("visibilitychange", sync);
    void (async () => {
      for (const id of new Set([getStudentDocIdFromAuthUser(user), user.uid])) {
        if (!id || stopped) continue;
        const ref = doc(db, "students", id);
        const snap = await getDoc(ref);
        if (!snap.exists() || stopped) continue;
        profileRef = ref;
        profile = snap.data();
        unsubscribeProfile = onSnapshot(ref, (next) => {
          const previousPreference = profile.activeStatusEnabled;
          profile = next.data() || {};
          if (previousPreference !== profile.activeStatusEnabled) sync();
        }, (error) => console.warn("[presence] Profile listener failed:", error));
        sync();
        break;
      }
    })().catch((error) => console.warn("[presence] Profile lookup failed:", error));
    const interval = setInterval(() => { if (visible() && profile.activeStatusEnabled !== false) sync(); }, 30_000);
    return () => {
      stopped = true;
      clearInterval(interval);
      stateSubscription.remove();
      unsubscribeNetwork();
      unsubscribeProfile?.();
      if (Platform.OS === "web" && typeof document !== "undefined") document.removeEventListener("visibilitychange", sync);
      offlinePublisher = undefined;
      void publish(true);
    };
  }, [user]);
}

export function useUserPresence(userId: string, studentId?: string | null) {
  const key = `${userId}|${studentId || ""}`;
  const [result, setResult] = useState<{ key: string; data: PresenceData | null } | null>(null);
  useEffect(() => {
    if (!userId) return;
    const setPresence = (data: PresenceData | null) => setResult({ key, data });
    if (studentId) return onSnapshot(doc(db, "students", studentId),
      (snap) => setPresence(snap.exists() ? snap.data() : null),
      (error) => console.warn("[presence] Listener failed:", error));
    const candidates = new Map<string, PresenceData>();
    const update = () => setPresence([...candidates.values()].sort((a, b) =>
      timestampMillis(b.lastSeen) - timestampMillis(a.lastSeen))[0] || null);
    const subscriptions = [...new Set([studentId, userId].filter(Boolean) as string[])].map((id) =>
      onSnapshot(doc(db, "students", id), (snap) => {
        if (snap.exists()) candidates.set(id, snap.data()); else candidates.delete(id);
        update();
      }, (error) => console.warn("[presence] Listener failed:", error)));
    subscriptions.push(onSnapshot(query(collection(db, "students"), where("userId", "==", userId)), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") candidates.delete(change.doc.id);
        else candidates.set(change.doc.id, change.doc.data());
      });
      update();
    }, (error) => console.warn("[presence] Lookup listener failed:", error)));
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [userId, studentId, key]);
  return result?.key === key ? result.data : null;
}
