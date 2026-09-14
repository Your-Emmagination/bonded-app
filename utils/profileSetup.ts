export const COMMUNITY_RULES_VERSION = "2026-09-12";

export const COMMUNITY_RULES = [
  { title: "Treat everyone with respect", text: "Do not harass, bully, threaten, or discriminate against other members." },
  { title: "Keep the community safe", text: "Do not share harmful, misleading, or inappropriate content. Follow school policies when posting, commenting, and messaging." },
  { title: "Protect privacy", text: "Do not share another person's private information or photos without permission. Keep your login credentials private." },
  { title: "Use your account responsibly", text: "Do not impersonate others or use BondED for academic dishonesty. Report harmful content to the moderators." },
];

export type SetupProfile = {
  userId?: string;
  uid?: string;
  studentID?: string;
  email?: string;
  recoveryEmail?: string;
  recoveryEmailVerified?: boolean;
  profileImage?: string | null;
  mustChangePassword?: boolean;
  communityRulesVersion?: string;
  communityRulesAcceptedAt?: unknown;
  [key: string]: unknown;
};

export function validPersonalEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && !/@(?:student|teacher|admin|moderator)\.csap$/i.test(email);
}

export function profileEmail(profile: SetupProfile): string {
  if (validPersonalEmail(profile.email)) return profile.email.trim();
  if (validPersonalEmail(profile.recoveryEmail)) return profile.recoveryEmail.trim();
  return "";
}

export function hasProfilePhoto(value: unknown): value is string {
  return typeof value === "string" && /^https:\/\/\S+$/i.test(value.trim());
}

export function hasVerifiedProfileEmail(profile: SetupProfile, email = profileEmail(profile)): boolean {
  return validPersonalEmail(email) && validPersonalEmail(profile.recoveryEmail)
    && profile.recoveryEmailVerified === true
    && email.trim().toLowerCase() === profile.recoveryEmail.trim().toLowerCase();
}

export function hasAcceptedCommunityRules(profile: SetupProfile): boolean {
  return profile.communityRulesVersion === COMMUNITY_RULES_VERSION
    && profile.communityRulesAcceptedAt != null;
}

export function getSetupStep(profile: SetupProfile): "password-check" | "password" | "profile" | "complete" {
  // Older accounts have no flag. Check their current password once without
  // forcing people who already chose a password to change it again.
  if (typeof profile.mustChangePassword !== "boolean") return "password-check";
  if (profile.mustChangePassword) return "password";
  if (!hasVerifiedProfileEmail(profile) || !hasProfilePhoto(profile.profileImage) || !hasAcceptedCommunityRules(profile)) return "profile";
  return "complete";
}
