export type CommunityMembershipState = "joined" | "pending" | "available";

export type CommunityChannel = {
  id: string;
  label: string;
  icon: string;
  hint?: string;
  emoji?: string;
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
};

const DEFAULT_CHANNEL_ICON = "chatbubbles-outline";
const DEFAULT_CHANNEL_EMOJI = "💬";
const DEFAULT_SERVER_EMOJI = "🏫";

const buildDefaultSections = (serverId: string): CommunitySection[] => [
  {
    id: `${serverId}_general_section`,
    title: "Class Channels",
    channels: [
      {
        id: `${serverId}_general`,
        label: "general",
        icon: DEFAULT_CHANNEL_ICON,
        emoji: DEFAULT_CHANNEL_EMOJI,
        hint: "Main class discussion",
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

  const firstSection = baseSections[0] ?? {
    id: `${serverId}_general_section`,
    title: "Class Channels",
    channels: [],
  };

  return [
    {
      ...firstSection,
      channels: [
        ...firstSection.channels,
        {
          id: normalizedId,
          label: slugifyLabel(nextLabel),
          icon: DEFAULT_CHANNEL_ICON,
          emoji,
          hint: description?.trim() || `${nextLabel.trim()} channel`,
        },
      ],
    },
    ...baseSections.slice(1),
  ];
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
  if (!isPublic && !isAdmin && !isStaff && !isOwner) {
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

