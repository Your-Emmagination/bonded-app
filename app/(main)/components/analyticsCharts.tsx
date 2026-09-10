// Presentational chart wrappers for the Analytics screen (Task 2).
// Every component takes already-fetched data as props — the screen owns all
// data loading, and each source is either getCountFromServer (a snapshot) or
// the dailyStats rollup (a trend). Charts render via react-native-gifted-charts
// (line/bar/donut) over react-native-svg + expo-linear-gradient.
import { Dimensions, StyleSheet, Text, View } from "react-native";
import { BarChart, LineChart, PieChart } from "react-native-gifted-charts";

const SCREEN_WIDTH = Dimensions.get("window").width;
// screen horizontal padding (16*2) + card padding (14*2)
const CHART_WIDTH = Math.max(240, SCREEN_WIDTH - 32 - 28);

export const CHART_COLORS = [
  "#5f0909",
  "#b86b1d",
  "#356a59",
  "#6e4aa3",
  "#a8583a",
  "#4b5563",
  "#2e8b68",
  "#8f1d2c",
  "#d39a32",
];

export type LinePoint = { value: number; label?: string };
export type NamedValue = { label: string; value: number };

function EmptyChart({ note }: { note: string }) {
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyText}>{note}</Text>
    </View>
  );
}

/** Line — daily active users from dailyStats. `data` is oldest→newest. */
export function DailyActiveUsersLine({
  data,
  rangeDays,
}: {
  data: LinePoint[];
  rangeDays: number;
}) {
  if (!data.some((point) => point.value > 0)) {
    return <EmptyChart note="No rollup data for this range yet." />;
  }
  const maxValue = Math.max(4, ...data.map((point) => point.value));
  const spacing =
    data.length > 1 ? (CHART_WIDTH - 24) / (data.length - 1) : CHART_WIDTH / 2;

  return (
    <View style={styles.chartClip}>
      <LineChart
        data={data}
        width={CHART_WIDTH}
        height={170}
        thickness={2.5}
        color="#356a59"
        areaChart
        curved
        startFillColor="#356a59"
        endFillColor="#356a59"
        startOpacity={0.18}
        endOpacity={0.02}
        hideDataPoints={rangeDays > 10}
        dataPointsColor="#356a59"
        dataPointsRadius={3}
        initialSpacing={12}
        endSpacing={8}
        spacing={spacing}
        noOfSections={4}
        maxValue={Math.ceil(maxValue * 1.15)}
        yAxisThickness={0}
        xAxisColor="#e5d4cc"
        rulesColor="#efe1da"
        yAxisTextStyle={styles.axisText}
        xAxisLabelTextStyle={styles.axisTextSmall}
      />
    </View>
  );
}

/** Horizontal bar — one row per named category. */
export function CategoryBar({
  data,
  color = "#5f0909",
  emptyNote = "Nothing to show yet.",
}: {
  data: NamedValue[];
  color?: string;
  emptyNote?: string;
}) {
  const rows = data.filter((row) => row.value > 0);
  if (rows.length === 0) return <EmptyChart note={emptyNote} />;

  const maxValue = Math.max(1, ...rows.map((row) => row.value));
  return (
    <View style={styles.chartClip}>
      <BarChart
        horizontal
        data={rows.map((row) => ({
          value: row.value,
          label: row.label,
          frontColor: color,
        }))}
        barWidth={16}
        spacing={18}
        height={Math.max(120, rows.length * 40)}
        width={CHART_WIDTH - 90}
        initialSpacing={6}
        noOfSections={3}
        maxValue={Math.ceil(maxValue * 1.15)}
        yAxisThickness={0}
        xAxisColor="#e5d4cc"
        rulesColor="#efe1da"
        yAxisLabelWidth={84}
        yAxisTextStyle={styles.axisTextSmall}
        xAxisLabelTextStyle={styles.axisTextSmall}
        barBorderRadius={3}
      />
    </View>
  );
}

/** Donut + manual legend. `data` is {label, value}; colors from CHART_COLORS. */
export function DistributionDonut({
  data,
  emptyNote = "No data yet.",
}: {
  data: NamedValue[];
  emptyNote?: string;
}) {
  const rows = data
    .map((row, index) => ({
      ...row,
      color: CHART_COLORS[index % CHART_COLORS.length],
    }))
    .filter((row) => row.value > 0);

  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return <EmptyChart note={emptyNote} />;

  return (
    <View style={styles.donutRow}>
      <PieChart
        donut
        radius={64}
        innerRadius={40}
        data={rows.map((row) => ({ value: row.value, color: row.color }))}
        innerCircleColor="#fffaf6"
        centerLabelComponent={() => (
          <View style={styles.donutCenter}>
            <Text style={styles.donutCenterValue}>{total}</Text>
            <Text style={styles.donutCenterLabel}>total</Text>
          </View>
        )}
      />
      <View style={styles.legend}>
        {rows.map((row) => (
          <View key={row.label} style={styles.legendRow}>
            <View style={[styles.legendSwatch, { backgroundColor: row.color }]} />
            <Text style={styles.legendLabel} numberOfLines={1}>
              {row.label}
            </Text>
            <Text style={styles.legendValue}>
              {row.value} · {Math.round((row.value / total) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chartClip: { overflow: "hidden", marginTop: 6 },
  axisText: { color: "#98766d", fontSize: 10 },
  axisTextSmall: { color: "#98766d", fontSize: 9.5 },
  emptyBox: {
    paddingVertical: 26,
    alignItems: "center",
  },
  emptyText: { color: "#a08a82", fontSize: 12, fontStyle: "italic" },
  donutRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginTop: 8,
  },
  donutCenter: { alignItems: "center" },
  donutCenterValue: { color: "#4c1b14", fontSize: 18, fontWeight: "900" },
  donutCenterLabel: { color: "#98766d", fontSize: 10 },
  legend: { flex: 1, gap: 7 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 7 },
  legendSwatch: { width: 11, height: 11, borderRadius: 3 },
  legendLabel: { flex: 1, color: "#4c1b14", fontSize: 12, fontWeight: "600" },
  legendValue: { color: "#8a6a60", fontSize: 11, fontWeight: "700" },
});

export default function AnalyticsChartsRoutePlaceholder() {
  return null;
}
