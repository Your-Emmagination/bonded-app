import { auth, db } from "@/Firebase_configure";
import { getSetupStep, type SetupProfile } from "@/utils/profileSetup";
import { saveCachedMyProfile } from "@/utils/offlineStorage";
import { updateUserDataCache } from "@/utils/rbac";
import { onAuthStateChanged, type User } from "firebase/auth";
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
          const accept = (profile: SetupProfile) => {
            if (current !== generation) return;
            updateUserDataCache([user.uid, snapshot.id], { email: profile.email, profileImage: profile.profileImage });
            void saveCachedMyProfile(user.uid, profile);
            setState({ user, profile, profileId: snapshot.id, error: null,
              status: getSetupStep(profile) === "complete" ? "ready" : "setup" });
          };
          accept(snapshot.data() as SetupProfile);
          stopProfile = onSnapshot(snapshot.ref, { includeMetadataChanges: true }, next => {
            // A locally queued write must never unlock Home before it is saved.
            if (next.metadata.hasPendingWrites || next.metadata.fromCache) return;
            if (!next.exists()) {
              setState({ ...initial, user, status: "error", error: "Your account profile is unavailable. Contact your school administrator." });
              return;
            }
            accept(next.data() as SetupProfile);
          }, () => {
            if (current === generation) setState({ ...initial, user, status: "error", error: "Unable to check your profile. Check your connection and try again." });
          });
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
