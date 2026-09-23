export type CommunityMembershipState = "joined" | "pending" | "available";

/**
 * What a channel is for, and so who may post in it. The saved values are the
 * original ones; what people see is newer:
 *   text          Open           everyone posts
 *   announcement  Read-only      staff post; students react and forward
 *   rules         Rules          read-only, with the rules look
 *   media         Collaborative  everyone posts, and anyone can pin
 *   staff         Staff only     admins, moderators, teachers; hidden from students
 */
export type ChannelType = "text" | "announcement" | "rules" | "media" | "staff";

/** The choices in Create Channel and Edit Channel, in this order. */
export const CHANNEL_TYPE_OPTIONS: {
  type: ChannelType;
  title: string;
  icon: string;
  emoji: string;
  hint: string;
}[] = [
  { type: "text", title: "Open", icon: "chatbubbles-outline", emoji: "💬", hint: "Everyone can post, reply and react" },
  { type: "announcement", title: "Read-only", icon: "megaphone-outline", emoji: "📢", hint: "Staff post; students react and forward" },
  { type: "rules", title: "Rules", icon: "shield-checkmark-outline", emoji: "📜", hint: "Guidelines; staff post, students react" },
  { type: "media", title: "Collaborative", icon: "folder-open-outline", emoji: "📂", hint: "Shared files and links; anyone can pin" },
  { type: "staff", title: "Staff only", icon: "lock-closed-outline", emoji: "🔒", hint: "Admins, moderators and teachers; hidden from students" },
];

export function getChannelTypeTitle(channelType?: ChannelType): string {
  return CHANNEL_TYPE_OPTIONS.find((option) => option.type === channelType)?.title || "Open";
}

/** App-wide staff: the only people who see Staff only channels. */
export function isStaffRole(role?: string | null): boolean {
  return ["admin", "teacher", "moderator"].includes(String(role || "").toLowerCase());
}

export type CommunityChannel = {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  emoji?: string;
  channelType?: ChannelType;
  badgeIcon?: string;
  unread?: boolean;
  unreadCount?: number;
};

export type CommunitySection = {
  id: string;
  title: string;
  channels: CommunityChannel[];
};

export type CommunityServer = {
  id: string;
  name: string;
  shortLabel: string;
  accent: string;
  memberCount: number;
  membershipLabel: string;
  autoJoined: boolean;
  sections: CommunitySection[];
  emoji?: string;
  logoUri?: string;
  bannerUri?: string;
  titleColor?: string;
  titleSize?: number;
  titleAlign?: "left" | "center" | "right";
  titleEdge?: "none" | "subtle" | "strong";
  titleStroke?: "none" | "subtle" | "medium" | "strong";
  titleStrokeColor?: string;
  titleStrokeSize?: number;
  descriptionSize?: number;
  tagline?: string;
  description?: string;
  verified?: boolean;
  isBuiltIn?: boolean;
  isCustom?: boolean;
  isPublic?: boolean;
  requiresApproval?: boolean;
  membershipState?: CommunityMembershipState;
  pendingRequestCount?: number;
  ownerId?: string;
  createdBy?: string;
  canManage?: boolean;
  isDeleted?: boolean;
  /** Each channel's type by id, for the database rules. See buildChannelAccess. */
  channelAccess?: Record<string, string>;
};

export type CustomCommunityServer = CommunityServer & {
  isCustom: true;
};

export type RemoteCommunityServerRecord = Partial<CustomCommunityServer> & {
  id: string;
  name: string;
  createdBy?: string;
  recordType?: string;
};

export type ServerMembershipRecord = {
  serverId: string;
  userId: string;
  status?: string;
};

export type ServerJoinRequestRecord = {
  serverId: string;
  userId: string;
  status?: string;
  requestedByRole?: string;
  requesterName?: string;
  course?: string;
  yearLevel?: string;
};

const DEFAULT_CHANNEL_ICON = "chatbubbles-outline";
const DEFAULT_CHANNEL_EMOJI = "💬";
const DEFAULT_SERVER_EMOJI = "🏫";

export function getChannelIcon(channelType?: ChannelType, fallbackIcon = DEFAULT_CHANNEL_ICON): string {
  switch (channelType) {
    case "rules":
      return "shield-checkmark-outline";
    case "announcement":
      return "megaphone-outline";
    case "media":
      return "folder-open-outline";
    case "staff":
      return "lock-closed-outline";
    case "text":
    default:
      return fallbackIcon || DEFAULT_CHANNEL_ICON;
  }
}

export function getChannelDefaultEmoji(channelType?: ChannelType): string {
  switch (channelType) {
    case "rules":
      return "📜";
    case "announcement":
      return "📢";
    case "media":
      return "📂";
    case "staff":
      return "🔒";
    case "text":
    default:
      return DEFAULT_CHANNEL_EMOJI;
  }
}

type ChannelLike = { channelType?: string; label?: string; id?: string } | null | undefined;

/**
 * A channel's type. Channels made before types were saved are recognised by
 * name, the way they always were.
 */
export function resolveChannelType(channel: ChannelLike): ChannelType {
  if (!channel) return "text";
  const saved = channel.channelType;
  if (saved === "text" || saved === "announcement" || saved === "rules" || saved === "media" || saved === "staff") {
    return saved;
  }
  const lowerLabel = (channel.label || "").toLowerCase();
  const lowerId = (channel.id || "").toLowerCase();
  if (lowerLabel === "rules" || lowerId.endsWith("_rules")) return "rules";
  if (
    lowerLabel === "announcement" ||
    lowerLabel === "announcements" ||
    lowerId.endsWith("_announcement") ||
    lowerId.endsWith("_announcements")
  ) {
    return "announcement";
  }
  if (lowerLabel === "media" || lowerId.endsWith("_media")) return "media";
  return "text";
}

/** Students can't post here: Read-only, Rules and Staff only channels. */
export function isStaffOnlyChannel(channel: ChannelLike): boolean {
  const type = resolveChannelType(channel);
  return type === "rules" || type === "announcement" || type === "staff";
}

/** Hidden from students altogether. */
export function isStaffChannel(channel: ChannelLike): boolean {
  return resolveChannelType(channel) === "staff";
}

/**
 * Every channel's type by id, saved on the server next to its channels. The
 * database rules read it to decide who may post (they can't search the
 * channel list), so it's rewritten whenever the channels change.
 */
export function buildChannelAccess(sections: CommunitySection[] | undefined): Record<string, ChannelType> {
  const access: Record<string, ChannelType> = {};
  for (const section of sections || []) {
    for (const channel of section.channels || []) {
      if (channel?.id) access[channel.id] = resolveChannelType(channel);
    }
  }
  return access;
}

/** The same list, as a string, to tell whether a saved one is out of date. */
export function channelAccessKey(access: Record<string, string> | null | undefined): string {
  return Object.keys(access || {})
    .sort()
    .map((id) => `${id}=${access?.[id]}`)
    .join("|");
}

/** A server's channels as this person may see them: no Staff only channels for students. */
export function sectionsVisibleTo(sections: CommunitySection[], role?: string | null): CommunitySection[] {
  if (isStaffRole(role)) return sections;
  return sections.map((section) => ({
    ...section,
    channels: (section.channels || []).filter((channel) => !isStaffChannel(channel)),
  }));
}

const buildDefaultSections = (serverId: string): CommunitySection[] => [
  {
    id: `${serverId}_info_section`,
    title: "Information",
    channels: [
      {
        id: `${serverId}_rules`,
        label: "rules",
        channelType: "rules",
        icon: "shield-checkmark-outline",
        emoji: "📜",
        hint: "Server rules and guidelines",
      },
      {
        id: `${serverId}_announcements`,
        label: "announcements",
        channelType: "announcement",
        icon: "megaphone-outline",
        emoji: "📢",
        hint: "Official notices and updates",
      },
    ],
  },
  {
    id: `${serverId}_general_section`,
    title: "Channels",
    channels: [
      {
        id: `${serverId}_general`,
        label: "general",
        channelType: "text",
        icon: DEFAULT_CHANNEL_ICON,
        emoji: DEFAULT_CHANNEL_EMOJI,
        hint: "Main class discussion",
      },
      {
        id: `${serverId}_media`,
        label: "media",
        channelType: "media",
        icon: "images-outline",
        emoji: "📸",
        hint: "Photos, videos, and file sharing",
      },
    ],
  },
];

function slugifyLabel(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "channel";
}

export function appendThreadToSections(
  sections: CommunitySection[] | undefined,
  serverId: string,
  label: string,
  emoji = DEFAULT_CHANNEL_EMOJI,
  description?: string,
  channelType: ChannelType = "text",
) {
  const nextLabel = label.trim();
  if (!nextLabel) {
    return Array.isArray(sections) && sections.length > 0
      ? sections
      : buildDefaultSections(serverId);
  }

  const baseSections =
    Array.isArray(sections) && sections.length > 0
      ? sections
      : buildDefaultSections(serverId);

  const normalizedId = `${serverId}_${slugifyLabel(nextLabel)}`;
  const alreadyExists = baseSections.some((section) =>
    section.channels.some((channel) => channel.id === normalizedId),
  );
  if (alreadyExists) {
    return baseSections;
  }

  const resolvedEmoji = emoji?.trim() || getChannelDefaultEmoji(channelType);
  const resolvedIcon = getChannelIcon(channelType);

  let targetSectionIndex = baseSections.findIndex((sec) =>
    sec.title.toLowerCase().includes(channelType === "rules" || channelType === "announcement" ? "info" : "channel"),
  );
  if (targetSectionIndex < 0) {
    targetSectionIndex = 0;
  }

  const targetSection = baseSections[targetSectionIndex] ?? {
    id: `${serverId}_channels_section`,
    title: "Channels",
    channels: [],
  };

  const updatedTargetSection = {
    ...targetSection,
    channels: [
      ...targetSection.channels,
      {
        id: normalizedId,
        label: slugifyLabel(nextLabel),
        channelType,
        icon: resolvedIcon,
        emoji: resolvedEmoji,
        hint: description?.trim() || `${nextLabel.trim()} channel`,
      },
    ],
  };

  const newSections = [...baseSections];
  newSections[targetSectionIndex] = updatedTargetSection;
  return newSections;
}

export function updateChannelInSections(
  sections: CommunitySection[] | undefined,
  serverId: string,
  channelId: string,
  updates: {
    label?: string;
    emoji?: string;
    hint?: string;
    channelType?: ChannelType;
  },
): CommunitySection[] {
  const baseSections =
    Array.isArray(sections) && sections.length > 0
      ? sections
      : buildDefaultSections(serverId);

  return baseSections.map((section) => ({
    ...section,
    channels: section.channels.map((channel) => {
      if (channel.id !== channelId) {
        return channel;
      }

      const nextChannelType = updates.channelType ?? channel.channelType ?? "text";
      const nextLabel = updates.label?.trim() ? slugifyLabel(updates.label) : channel.label;
      const nextEmoji = updates.emoji?.trim() || channel.emoji || getChannelDefaultEmoji(nextChannelType);
      const nextIcon = getChannelIcon(nextChannelType, channel.icon);
      const nextHint = updates.hint !== undefined ? updates.hint.trim() : channel.hint;

      return {
        ...channel,
        label: nextLabel,
        channelType: nextChannelType,
        emoji: nextEmoji,
        icon: nextIcon,
        hint: nextHint,
      };
    }),
  }));
}

export function deleteChannelFromSections(
  sections: CommunitySection[] | undefined,
  serverId: string,
  channelId: string,
): CommunitySection[] {
  const baseSections =
    Array.isArray(sections) && sections.length > 0
      ? sections
      : buildDefaultSections(serverId);

  return baseSections.map((section) => ({
    ...section,
    channels: section.channels.filter((channel) => channel.id !== channelId),
  }));
}

function ensureCustomServerShape(
  server: Partial<CustomCommunityServer> &
    Pick<CustomCommunityServer, "id" | "name">,
): CustomCommunityServer {
  const name = server.name?.trim() || "Custom Server";
  const safeSections =
    Array.isArray(server.sections) && server.sections.length > 0
      ? server.sections
      : buildDefaultSections(server.id);

  return {
    id: server.id,
    name,
    shortLabel:
      server.shortLabel?.trim() ||
      name
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() || "")
        .join("")
        .slice(0, 4) ||
      "SRV",
    accent: server.accent ?? "#5f0909",
    memberCount: server.memberCount ?? 0,
    membershipLabel: server.membershipLabel ?? "Community server",
    autoJoined: server.autoJoined ?? false,
    sections: safeSections,
    description: server.description,
    verified: server.verified ?? false,
    emoji: server.emoji ?? DEFAULT_SERVER_EMOJI,
    logoUri: server.logoUri,
    bannerUri: server.bannerUri,
    titleColor: server.titleColor ?? "#fffaf7",
    titleSize: server.titleSize ?? 22,
    titleAlign: server.titleAlign ?? "left",
    titleEdge: server.titleEdge ?? "none",
    titleStroke: server.titleStroke ?? "none",
    titleStrokeColor: server.titleStrokeColor ?? "#000000",
    titleStrokeSize: server.titleStrokeSize ?? 0,
    descriptionSize: server.descriptionSize ?? 13,
    tagline: server.tagline,
    isPublic: server.isPublic ?? true,
    requiresApproval: server.requiresApproval ?? true,
    isBuiltIn: false,
    isCustom: true,
    membershipState: server.membershipState ?? "joined",
    pendingRequestCount: server.pendingRequestCount ?? 0,
    ownerId: server.ownerId,
    canManage: server.canManage ?? false,
    isDeleted: server.isDeleted ?? false,
  };
}

export const COURSE_SERVER_MAP: Record<string, string> = {
  bsis: "bsis",
  "bachelor of science in information system": "bsis",
  "bachelor of science in information systems": "bsis",
  "bs information systems": "bsis",
  "bs information system": "bsis",
  bscs: "bsit",
  "bs computer science": "bsit",
  bsit: "bsit",
  "bachelor of science in information technology": "bsit",
  "bs information technology": "bsit",
  crim: "crim",
  bscrim: "crim",
  "bs criminology": "crim",
  criminology: "crim",
  bsn: "nursing",
  "bs nursing": "nursing",
  nursing: "nursing",
  bsed: "education",
  "bs education": "education",
  beed: "education",
  education: "education",
  bsce: "engineering",
  bsme: "engineering",
  bsee: "engineering",
  engineering: "engineering",
  bsba: "business",
  "bs business administration": "business",
  bsa: "business",
  "bs accountancy": "business",
  abpsych: "psychology",
  "bs psychology": "psychology",
  psychology: "psychology",
};

export function getCourseServerId(course?: string): string | null {
  if (!course) return null;
  const normalizedCourse = course.toLowerCase().trim().replace(/\s+/g, " ");
  return COURSE_SERVER_MAP[normalizedCourse] ?? null;
}

const SYSTEM_SERVERS: CommunityServer[] = [];

type BuildArgs = {
  userProfile?: {
    course?: string;
    role?: string;
  } | null;
  userRole?: string;
  currentUserId?: string | null;
  remoteServers?: RemoteCommunityServerRecord[];
  memberships?: ServerMembershipRecord[];
  joinRequests?: ServerJoinRequestRecord[];
};

function dedupeServers(servers: CommunityServer[]) {
  const map = new Map<string, CommunityServer>();
  servers.forEach((server) => {
    map.set(server.id, server);
  });
  return Array.from(map.values());
}

function buildSystemServersForUser(
  userProfile: BuildArgs["userProfile"],
  userRole?: string,
  currentUserId?: string | null,
  memberships: ServerMembershipRecord[] = [],
  joinRequests: ServerJoinRequestRecord[] = [],
  overrides?: Map<string, RemoteCommunityServerRecord>,
): CommunityServer[] {
  const isAdmin = userRole === "admin";
  const isStaff = ["admin", "teacher", "moderator"].includes(userRole || "");
  const courseServerId = getCourseServerId(userProfile?.course);
  const baseVisible = isStaff
    ? SYSTEM_SERVERS
    : SYSTEM_SERVERS.filter(
        (server) =>
          server.id === "csap" ||
          (server.id === courseServerId && server.isPublic === true),
      );

  const mergedServers: CommunityServer[] = [];

  baseVisible.forEach((server) => {
    const override = overrides?.get(server.id);
    if (override?.isDeleted) {
      return;
    }

    const joined =
      server.id === "csap" ||
      (!!currentUserId &&
        memberships.some(
          (membership) =>
            membership.serverId === server.id &&
            membership.userId === currentUserId &&
            membership.status !== "removed",
        ));
    const pending =
      !!currentUserId &&
      joinRequests.some(
        (request) =>
          request.serverId === server.id &&
          request.userId === currentUserId &&
          request.status === "pending",
      );
    const membershipState: CommunityMembershipState = joined
      ? "joined"
      : pending
        ? "pending"
        : "available";
    const canManage = isAdmin || (["teacher", "moderator"].includes(userRole || "") && joined);

    mergedServers.push({
      ...server,
      ...override,
      id: server.id,
      sections:
        Array.isArray(override?.sections) && override.sections.length > 0
          ? override.sections
          : server.sections,
      autoJoined: joined,
      membershipState,
      canManage,
      isBuiltIn: true,
      isCustom: false,
    });
  });

  return dedupeServers(mergedServers);
}

function normalizeRemoteServer(
  server: RemoteCommunityServerRecord,
  userRole: string | undefined,
  currentUserId: string | null | undefined,
  memberships: ServerMembershipRecord[],
  joinRequests: ServerJoinRequestRecord[],
): CustomCommunityServer | null {
  if (server.recordType === "aiMemory") {
    return null;
  }
  const joined =
    !!currentUserId &&
    memberships.some(
      (membership) =>
        membership.serverId === server.id &&
        membership.userId === currentUserId &&
        membership.status !== "removed",
    );
  const pending =
    !!currentUserId &&
    joinRequests.some(
      (request) =>
        request.serverId === server.id &&
        request.userId === currentUserId &&
        request.status === "pending",
    );
  const isAdmin = userRole === "admin";
  const isStaff = ["teacher", "moderator"].includes(userRole || "");
  const isOwner =
    !!currentUserId &&
    (server.ownerId === currentUserId || server.createdBy === currentUserId);

  const canManage =
    isAdmin || isOwner || (isStaff && joined);

  const membershipState: CommunityMembershipState = joined || canManage
    ? "joined"
    : pending
      ? "pending"
      : "available";

  const isPublic = server.isPublic ?? true;
  // A private server is invite-only: hidden from everyone except staff, its
  // owner, and the people added to it. Members were missing from this list,
  // so somebody added to a private server still could not see it.
  if (!isPublic && !isAdmin && !isStaff && !isOwner && !joined) {
    return null;
  }
  const visible =
    isPublic ||
    canManage ||
    joined ||
    pending ||
    (isStaff && !isPublic) ||
    (isAdmin && !isPublic);
  if (!visible || server.isDeleted) {
    return null;
  }

  const pendingRequestCount = joinRequests.filter(
    (request) => request.serverId === server.id && request.status === "pending",
  ).length;

  return ensureCustomServerShape({
    ...server,
    // Staff only channels never reach a student's lists.
    ...(Array.isArray(server.sections) && server.sections.length > 0
      ? { sections: sectionsVisibleTo(server.sections, userRole) }
      : {}),
    autoJoined: membershipState === "joined",
    membershipLabel:
      server.membershipLabel ??
      (isPublic ? "Public server" : "Private community"),
    membershipState,
    pendingRequestCount,
    canManage,
    isPublic,
    requiresApproval: server.requiresApproval ?? true,
    ownerId: server.ownerId || server.createdBy,
  });
}

export function buildCommunityServers({
  userProfile,
  userRole,
  currentUserId,
  remoteServers = [],
  memberships = [],
  joinRequests = [],
}: BuildArgs): CommunityServer[] {
  const realRemoteServers = remoteServers.filter(
    (server) => server.recordType !== "aiMemory",
  );
  const systemIds = new Set(SYSTEM_SERVERS.map((server) => server.id));
  const systemOverrides = new Map(
    realRemoteServers
      .filter((server) => systemIds.has(server.id))
      .map((server) => [server.id, server] as const),
  );
  const builtIns = buildSystemServersForUser(
    userProfile,
    userRole,
    currentUserId,
    memberships,
    joinRequests,
    systemOverrides,
  );
  const customs = realRemoteServers
    .filter((server) => !systemIds.has(server.id))
    .map((server) =>
      normalizeRemoteServer(
        server,
        userRole,
        currentUserId,
        memberships,
        joinRequests,
      ),
    )
    .filter(Boolean) as CustomCommunityServer[];

  return [...builtIns, ...customs];
}

let customServerCounter = 0;

export function makeCustomCommunityServerDraft(
  name: string,
  description?: string,
  accent?: string,
  emoji?: string,
): CustomCommunityServer {
  customServerCounter += 1;
  const id = `custom_${Date.now()}_${customServerCounter}`;
  return ensureCustomServerShape({
    id,
    name,
    description,
    accent: accent ?? "#5f0909",
    emoji: emoji ?? DEFAULT_SERVER_EMOJI,
    sections: buildDefaultSections(id),
    memberCount: 1,
    membershipLabel: "Public server",
    isPublic: true,
    requiresApproval: true,
    isCustom: true,
  });
}

