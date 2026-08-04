export type AvatarSourceCandidate = {
  profileImage?: string | null;
  profilePic?: string | null;
};

const cleanAvatarValue = (value?: string | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const resolveAvatarUri = (
  source?: AvatarSourceCandidate | null,
): string | null => {
  if (!source) return null;
  return cleanAvatarValue(source.profileImage) || cleanAvatarValue(source.profilePic);
};
