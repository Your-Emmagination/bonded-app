import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useCallback, useEffect, useRef, useState } from "react";
import { db } from "../Firebase_configure";
import { timestampMillis } from "./messengerState";

// Separate from conversations: typing in an unopened draft never creates an inbox entry.
export function useDirectTyping(conversationId: string, userId: string, recipientId: string, enabled: boolean) {
  const [isTyping, setIsTyping] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastWrite = useRef(0);
  const active = useRef(false);
  const write = useCallback((value: boolean) => {
    if (!conversationId || !userId || !recipientId || userId === recipientId) return;
    void setDoc(doc(db, "directTyping", conversationId, "users", userId), {
      userId, participants: [userId, recipientId].sort(), active: value, updatedAt: serverTimestamp(),
    }).catch(() => { /* Ephemeral status expires if a device loses its connection. */ });
  }, [conversationId, userId, recipientId]);
  const stopTyping = useCallback(() => {
    clearTimeout(idleTimer.current);
    if (active.current) write(false);
    active.current = false;
    lastWrite.current = 0;
  }, [write]);
  const onTextChanged = useCallback((text: string) => {
    if (!enabled || !text.trim()) { stopTyping(); return; }
    if (!active.current || Date.now() - lastWrite.current >= 2000) {
      write(true);
      lastWrite.current = Date.now();
    }
    active.current = true;
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(stopTyping, 3000);
  }, [enabled, stopTyping, write]);
  useEffect(() => {
    if (!enabled) stopTyping();
    return stopTyping;
  }, [enabled, stopTyping]);
  useEffect(() => {
    if (!enabled || !conversationId || !recipientId) return;
    let expiry: ReturnType<typeof setTimeout>;
    const unsubscribe = onSnapshot(doc(db, "directTyping", conversationId, "users", recipientId), (snapshot) => {
      clearTimeout(expiry);
      const data = snapshot.data();
      const remaining = timestampMillis(data?.updatedAt) + 6000 - Date.now();
      setIsTyping(data?.active === true && remaining > 0);
      if (remaining > 0) expiry = setTimeout(() => setIsTyping(false), remaining);
    }, () => setIsTyping(false));
    return () => { unsubscribe(); clearTimeout(expiry); };
  }, [conversationId, recipientId, enabled]);
  return { isTyping: enabled && isTyping, onTextChanged, stopTyping };
}
