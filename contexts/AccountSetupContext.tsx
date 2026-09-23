import { auth, db } from "@/Firebase_configure";
import { timestampMillis } from "@/utils/messengerState";
import { endPresenceSession } from "@/utils/presence";
import { getSetupStep, type SetupProfile } from "@/utils/profileSetup";
import { saveCachedMyProfile } from "@/utils/offlineStorage";
import { isPushNotificationsSupported, unregisterDeviceForPushNotifications } from "@/utils/pushNotifications";
import { updateUserDataCache } from "@/utils/rbac";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { collection, doc, getDocFromServer, getDocsFromServer, limit, onSnapshot, query, where } from "firebase/firestore";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type AccountState = {
  user: User | null;
  status: "loading" | "signed-out" | "setup" | "ready" | "error";
  profile: SetupProfile | null;
  profileId: string | null;
  error: string | null;
};
const initial: AccountState = { user: null, status: "loading", profile: null, profileId: null, error: null };
const AccountSetupContext = createContext<AccountState & { retry: () => void }>({ ...initial, retry: () => {} });

let loginPreparation: Promise<void> = Promise.resolve();
export function beginLoginPreparation(): () => void {
  let finish = () => {};
  loginPreparation = new Promise<void>(resolve => { finish = resolve; });
  return finish;
}

// Why the app last signed someone out by itself, for the sign-in screen to
// explain once. Set when an admin locks the account or signs it out.
let signOutNotice: string | null = null;
export function takeSignOutNotice(): string | null {
  const notice = signOutNotice;
  signOutNotice = null;
  return notice;
}

export async function findSetupProfile(user: User) {
  const ids = [...new Set([user.email?.split("@")[0], user.uid].filter(Boolean) as string[])];
  for (const id of ids) {
    const snapshot = await getDocFromServer(doc(db, "students", id));
    if (snapshot.exists() && (snapshot.data().userId === user.uid || snapshot.data().uid === user.uid)) return snapshot;
  }
  for (const field of ["userId", "uid"]) {
    const snapshots = await getDocsFromServer(query(collection(db, "students"), where(field, "==", user.uid), limit(1)));
    if (!snapshots.empty) return snapshots.docs[0];
  }
  throw new Error("Your account profile could not be found. Contact your school administrator.");
}

export function AccountSetupProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AccountState>(initial);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    let generation = 0;
    let stopProfile: (() => void) | undefined;
    const stopAuth = onAuthStateChanged(auth, user => {
      const current = ++generation;
      stopProfile?.();
      stopProfile = undefined;
      setState({ ...initial, user, status: user ? "loading" : "signed-out" });
      if (!user) return;
      void (async () => {
        try {
          // Let the login screen finish its legacy password check before
          // exposing setup controls that could change the same credential.
          await loginPreparation;
          if (current !== generation) return;
          const snapshot = await findSetupProfile(user);
          if (current !== generation) return;
          // An admin locked the account, or signed it out everywhere (Manage
          // Users → Account recovery). Leave now, not when this sign-in
          // would have run out on its own up to an hour later — detaching
          // the phone from the account's notifications on the way out.
          let leaving = false;
          const leave = (locked: boolean) => {
            if (leaving || current !== generation) return;
            leaving = true;
            signOutNotice = locked
              ? "This account is locked. Contact the school for help."
              : "An administrator signed this account out. Sign in again to continue.";
            void (async () => {
              await endPresenceSession().catch(() => undefined);
              if (isPushNotificationsSupported()) {
                await unregisterDeviceForPushNotifications(user).catch(() => false);
              }
              await signOut(auth).catch(() => undefined);
            })();
          };
          const accept = (profile: SetupProfile) => {
            if (current !== generation) return;
            if (profile.accountLocked === true) {
              leave(true);
              return;
            }
            // Only sessions that began before the sign-out end; signing in
            // again afterwards is fine.
            const revokedMs = timestampMillis(profile.sessionsRevokedAt);
            if (revokedMs) {
              user.getIdTokenResult()
                .then(({ claims }) => {
                  // When this device signed in, in seconds, from the token.
                  const signedInMs = Number(claims.auth_time) * 1000;
                  if (signedInMs && signedInMs < revokedMs) leave(false);
                })
                .catch(() => undefined);
            }
            updateUserDataCache([user.uid, snapshot.id], { email: profile.email, profileImage: profile.profileImage });
            void saveCachedMyProfile(user.uid, profile);
            setState({ user, profile, profileId: snapshot.id, error: null,
              status: getSetupStep(profile) === "complete" ? "ready" : "setup" });
          };
          // Personal email and recovery details are in a private record only
          // this person (and admins) can read; the public profile everyone
          // reads no longer carries them. A profile not moved yet still has
          // them on the public one, so the private record wins only where it
          // has a value. It may not exist yet, or the rules may not allow it
          // yet — either way the public profile alone still works.
          const privateRef = doc(db, "studentPrivate", snapshot.id);
          let publicProfile = snapshot.data() as SetupProfile;
          let privateProfile: Partial<SetupProfile> = await getDocFromServer(privateRef)
            .then((found) => (found.exists() ? (found.data() as Partial<SetupProfile>) : {}))
            .catch(() => ({}));
          if (current !== generation) return;
          const merged = () => ({ ...publicProfile, ...privateProfile }) as SetupProfile;
          accept(merged());
          const stopPublic = onSnapshot(snapshot.ref, { includeMetadataChanges: true }, next => {
            // A locally queued write must never unlock Home before it is saved.
            if (next.metadata.hasPendingWrites || next.metadata.fromCache) return;
            if (!next.exists()) {
              setState({ ...initial, user, status: "error", error: "Your account profile is unavailable. Contact your school administrator." });
              return;
            }
            publicProfile = next.data() as SetupProfile;
            accept(merged());
          }, () => {
            if (current === generation) setState({ ...initial, user, status: "error", error: "Unable to check your profile. Check your connection and try again." });
          });
          const stopPrivate = onSnapshot(privateRef, { includeMetadataChanges: true }, next => {
            if (next.metadata.hasPendingWrites || next.metadata.fromCache) return;
            privateProfile = next.exists() ? (next.data() as Partial<SetupProfile>) : {};
            accept(merged());
          }, () => undefined);
          stopProfile = () => {
            stopPublic();
            stopPrivate();
          };
        } catch (error) {
          if (current === generation) setState({ ...initial, user, status: "error", error: error instanceof Error ? error.message : "Unable to check your profile. Please try again." });
        }
      })();
    });
    return () => { generation++; stopAuth(); stopProfile?.(); };
  }, [attempt]);

  return <AccountSetupContext.Provider value={{ ...state, retry }}>{children}</AccountSetupContext.Provider>;
}

export const useAccountSetup = () => useContext(AccountSetupContext);
