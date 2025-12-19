// app/(main)/(tabs)/DashboardScreen.tsx
import React, { useEffect, useState } from "react";
import { 
  View, 
  Text, 
  StyleSheet, 
  ScrollView, 
  ActivityIndicator,
  TouchableOpacity,
  Dimensions,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { collection, query, onSnapshot, where } from "firebase/firestore";
import { db, auth } from "../../../Firebase_configure";
import { useRouter } from "expo-router";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

export default function DashboardScreen() {
  const [userRole, setUserRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    totalPosts: 0,
    totalPolls: 0,
    totalUsers: 0,
    onlineUsers: 0,
    totalComments: 0,
    totalEvents: 0,
  });
  const router = useRouter();

  useEffect(() => {
    const loadRole = async () => {
      try {
        const role = await AsyncStorage.getItem("userRole");
        console.log("📊 Dashboard - User Role:", role);
        setUserRole(role);
      } catch (error) {
        console.error("Error loading role:", error);
      } finally {
        setLoading(false);
      }
    };
    loadRole();
  }, []);

  

  // Real-time stats listeners
  useEffect(() => {
    if (!auth.currentUser) return;

    const unsubscribers: (() => void)[] = [];

    // Posts count
    const postsQuery = query(collection(db, "posts"));
    const unsubPosts = onSnapshot(postsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalPosts: snapshot.size }));
    });
    unsubscribers.push(unsubPosts);

    // Polls count
    const pollsQuery = query(collection(db, "polls"));
    const unsubPolls = onSnapshot(pollsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalPolls: snapshot.size }));
    });
    unsubscribers.push(unsubPolls);

    // Users count
    const usersQuery = query(collection(db, "students"));
    const unsubUsers = onSnapshot(usersQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalUsers: snapshot.size }));
    });
    unsubscribers.push(unsubUsers);

    // Online users count
    const onlineQuery = query(collection(db, "students"), where("isOnline", "==", true));
    const unsubOnline = onSnapshot(onlineQuery, (snapshot) => {
      setStats(prev => ({ ...prev, onlineUsers: snapshot.size }));
    });
    unsubscribers.push(unsubOnline);

    // Comments count
    const commentsQuery = query(collection(db, "comments"));
    const unsubComments = onSnapshot(commentsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalComments: snapshot.size }));
    });
    unsubscribers.push(unsubComments);

    // Events count
    const eventsQuery = query(collection(db, "events"));
    const unsubEvents = onSnapshot(eventsQuery, (snapshot) => {
      setStats(prev => ({ ...prev, totalEvents: snapshot.size }));
    });
    unsubscribers.push(unsubEvents);

    return () => {
      unsubscribers.forEach(unsub => unsub());
    };
  }, []);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color="#ff3b7f" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Dashboard</Text>
            <Text style={styles.subtitle}>Welcome back, {userRole?.toUpperCase()}</Text>
          </View>
          <View style={[styles.roleBadge, { backgroundColor: getRoleColor(userRole) }]}>
            <Ionicons name={getRoleIcon(userRole)} size={20} color="#fff" />
          </View>
        </View>

        {/* Stats Grid */}
        <View style={styles.statsGrid}>
          <StatCard
            icon="newspaper"
            iconColor="#4f9cff"
            label="Total Posts"
            value={stats.totalPosts}
          />
          <StatCard
            icon="bar-chart"
            iconColor="#a86fff"
            label="Total Polls"
            value={stats.totalPolls}
          />
          <StatCard
            icon="people"
            iconColor="#ff9f43"
            label="Total Users"
            value={stats.totalUsers}
          />
          <StatCard
            icon="ellipse"
            iconColor="#2ecc71"
            label="Online Now"
            value={stats.onlineUsers}
          />
          <StatCard
            icon="chatbubbles"
            iconColor="#ff5c93"
            label="Comments"
            value={stats.totalComments}
          />
          <StatCard
            icon="calendar"
            iconColor="#00d4ff"
            label="Events"
            value={stats.totalEvents}
          />
        </View>

        {/* Quick Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          
          {(userRole === "admin" || userRole === "teacher" || userRole === "moderator") && (
            <>
              <ActionButton
                icon="calendar-outline"
                label="Manage Events"
                color="#00d4ff"
                onPress={() => router.push("/EventCalendarScreen")}
              />
              
              {userRole === "admin" && (
                <ActionButton
                  icon="people-outline"
                  label="Manage Users"
                  color="#ff9f43"
                  onPress={() => console.log("User Management - Coming Soon")}
                />
              )}
              
              <ActionButton
                icon="flag-outline"
                label="View Reports"
                color="#ff5c93"
                onPress={() => console.log("Reports - Coming Soon")}
              />
            </>
          )}
        </View>

        {/* Info Card */}
        <View style={styles.infoCard}>
          <Ionicons name="information-circle" size={24} color="#ff3b7f" />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Role Permissions</Text>
            <Text style={styles.infoText}>
              {getRoleDescription(userRole)}
            </Text>
          </View>
        </View>

        {/* Recent Activity Placeholder */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Recent Activity</Text>
          <View style={styles.comingSoonCard}>
            <Ionicons name="time-outline" size={48} color="#3a4a6a" />
            <Text style={styles.comingSoonText}>Activity Feed Coming Soon</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// Stat Card Component
interface StatCardProps {
  icon: keyof typeof Ionicons.glyphMap;
  iconColor: string;
  label: string;
  value: number;
}

const StatCard: React.FC<StatCardProps> = ({ icon, iconColor, label, value }) => (
  <View style={styles.statCard}>
    <View style={[styles.statIconContainer, { backgroundColor: iconColor + "20" }]}>
      <Ionicons name={icon} size={24} color={iconColor} />
    </View>
    <Text style={styles.statValue}>{value.toLocaleString()}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

// Action Button Component
interface ActionButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
  onPress: () => void;
}

const ActionButton: React.FC<ActionButtonProps> = ({ icon, label, color, onPress }) => (
  <TouchableOpacity 
    style={[styles.actionButton, { borderLeftColor: color }]}
    onPress={onPress}
    activeOpacity={0.7}
  >
    <View style={[styles.actionIconContainer, { backgroundColor: color + "20" }]}>
      <Ionicons name={icon} size={20} color={color} />
    </View>
    <Text style={styles.actionLabel}>{label}</Text>
    <Ionicons name="chevron-forward" size={20} color="#8ea0d0" />
  </TouchableOpacity>
);

function getRoleColor(role: string | null) {
  const colors: Record<string, string> = {
    admin: "#ff3b7f",
    teacher: "#ff9f43",
    moderator: "#a86fff",
  };
  return colors[role || ""] || "#ff3b7f";
}

function getRoleIcon(role: string | null) {
  const iconMap: Record<string, keyof typeof Ionicons.glyphMap> = {
    admin: "shield-checkmark",
    teacher: "school",
    moderator: "shield-half",
  };
  return iconMap[role || ""] || "person";
}

function getRoleDescription(role: string | null) {
  const descriptions: Record<string, string> = {
    admin: "Full system access. Manage users, roles, and all content. View analytics and reports.",
    teacher: "Manage content and events. Delete posts/comments. View and handle reports.",
    moderator: "Monitor and moderate content. Delete inappropriate posts/comments. Handle user reports.",
  };
  return descriptions[role || ""] || "Limited access.";
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0e1320",
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    paddingBottom: 100,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#ff3b7f",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: "#8ea0d0",
    fontWeight: "500",
  },
  roleBadge: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    width: (SCREEN_WIDTH - 44) / 2,
    backgroundColor: "#1c2535",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#243054",
  },
  statIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 12,
  },
  statValue: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#e9edff",
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 13,
    color: "#8ea0d0",
    textAlign: "center",
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#ff3b7f",
    marginBottom: 12,
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1c2535",
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderLeftWidth: 4,
    borderWidth: 1,
    borderColor: "#243054",
  },
  actionIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  actionLabel: {
    flex: 1,
    color: "#e9edff",
    fontSize: 15,
    fontWeight: "600",
  },
  infoCard: {
    backgroundColor: "#1c2535",
    borderLeftWidth: 4,
    borderLeftColor: "#ff3b7f",
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    flexDirection: "row",
    gap: 12,
    borderWidth: 1,
    borderColor: "#243054",
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    color: "#ff3b7f",
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 6,
  },
  infoText: {
    color: "#b8c7ff",
    fontSize: 13,
    lineHeight: 20,
  },
  comingSoonCard: {
    backgroundColor: "#1c2535",
    borderRadius: 12,
    padding: 40,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#243054",
  },
  comingSoonText: {
    color: "#8ea0d0",
    fontSize: 14,
    marginTop: 12,
    fontWeight: "500",
  },
});