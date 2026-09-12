import { EmailAuthProvider, reauthenticateWithCredential, updatePassword, type User } from "firebase/auth";
import { validateNewPassword } from "./passwordPolicy";
import { checkAccountPassword } from "./passwordReset";

export async function changeAccountPassword(user: User, studentID: string, currentPassword: string, newPassword: string) {
  if (!currentPassword) throw new Error("Enter your current password.");
  if (currentPassword === newPassword) throw new Error("Choose a password different from your current one.");
  const error = validateNewPassword(newPassword);
  if (error) throw new Error(error);
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email || "", currentPassword));
  await updatePassword(user, newPassword);
  try {
    await user.getIdToken(true);
    const result = await checkAccountPassword(studentID, newPassword);
    if (result.mustChangePassword) throw new Error("Choose a password different from the school-issued temporary password.");
  } catch {
    throw new Error("Your password was changed, but account setup could not be updated. Sign out and sign in with your NEW password to finish setup.");
  }
}
