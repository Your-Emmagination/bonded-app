// Dependencies are supplied by the Worker so this authentication boundary can
// be tested without contacting production Firebase or receiving real passwords.
export async function checkAccountPassword(env, request, body, { lookupUser, readProfile, patchProfile, isTemporaryPassword = async () => false, fetchImpl = fetch }) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  if (!token) return { status: 401, body: { error: "Sign in to continue." } };
  const account = await lookupUser(env, token);
  const studentID = typeof body.studentID === "string" ? body.studentID.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!studentID || !password || password.length > 4096) return { status: 400, body: { error: "Enter your current password." } };
  const profile = await readProfile(env, studentID);
  if (!profile || (profile.userId || profile.uid) !== account.localId) {
    return { status: 403, body: { error: "This profile does not belong to your account." } };
  }
  // Firebase enforces credential validation and sign-in rate limits. Never
  // trust a client-supplied completion flag or store the submitted password.
  const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(env.FIREBASE_WEB_API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: account.email, password, returnSecureToken: true }),
  });
  const credential = await response.json().catch(() => null);
  if (!response.ok || credential?.localId !== account.localId) {
    return { status: response.status === 429 ? 429 : 400, body: { error: "Could not verify your password. Check it and try again, or try again later if you have made too many attempts." } };
  }
  // Both existing account creators use the exact, case-sensitive last name.
  // An admin's account-recovery reset issues a random one instead, which has
  // to be replaced just the same.
  const mustChangePassword = (!!profile.lastname && password === `${String(profile.lastname).trim()}12345`)
    || await isTemporaryPassword(env, account.localId, password);
  await patchProfile(env, studentID, { mustChangePassword, passwordCheckedAt: new Date().toISOString() });
  return { status: 200, body: { mustChangePassword } };
}
