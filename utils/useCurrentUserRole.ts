// utils/useCurrentUserRole.ts
//
// The signed-in user's role, kept live.
//
// Screens used to read the role once when they mounted, so an admin promoting
// or demoting someone left the interface showing the old one until that screen
// was re-entered: a demoted account went on offering staff buttons the server
// would refuse, and a promoted one saw none of the tools it had just been
// given. This follows the profile document instead, so the answer changes
// within a moment of the role itself changing.
import { onAuthStateChanged } from "firebase/auth";
import { useEffect, useState } from "react";

import { auth } from "../Firebase_configure";
import {
  getUserData,
  peekUserData,
  subscribeToCurrentUserProfile,
  type UserRole,
} from "./rbac";

export function useCurrentUserRole(): UserRole | undefined {
  const [role, setRole] = useState<UserRole | undefined>(() => {
    const uid = auth.currentUser?.uid;
    return uid ? peekUserData(uid)?.role : undefined;
  });

  useEffect(() => {
    let active = true;
    let unsubscribeProfile: (() => void) | undefined;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      unsubscribeProfile?.();
      unsubscribeProfile = undefined;

      if (!user) {
        if (active) setRole(undefined);
        return;
      }

      // Answer from cache first so a role-gated screen is not blank for a
      // round trip; the subscription below then corrects it.
      void getUserData(user.uid)
        .then((data) => {
          if (active) setRole(data?.role);
        })
        .catch(() => undefined);

      unsubscribeProfile = subscribeToCurrentUserProfile(user, (profile) => {
        if (active) setRole(profile?.role);
      });
    });

    return () => {
      active = false;
      unsubscribeProfile?.();
      unsubscribeAuth();
    };
  }, []);

  return role;
}
