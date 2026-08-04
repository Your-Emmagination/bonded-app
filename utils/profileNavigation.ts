export const buildUserProfileHref = ({
  userId,
  profileDocId,
  returnTo,
}: {
  userId?: string | null;
  profileDocId?: string | null;
  returnTo?: string | null;
}) => {
  const params = new URLSearchParams();

  if (userId) {
    params.set("userId", userId);
  }

  if (profileDocId) {
    params.set("profileDocId", profileDocId);
  }

  if (returnTo) {
    params.set("returnTo", returnTo);
  }

  const query = params.toString();
  return query ? `/UserProfileScreen?${query}` : "/UserProfileScreen";
};
