// Presentational chart wrappers for the Analytics screen (Task 2).
// Every component takes already-fetched data as props — the screen owns all
// data loading, and each source is either getCountFromServer (a snapshot) or
// the dailyStats rollup (a trend). Charts render via react-native-gifted-charts
// (line/bar/donut) over react-native-svg + expo-linear-gradient.
import { useMemo } from "react";
import { useThemeColors } from "@/contexts/ThemeContext";
import type { ThemeTokens } from "@/utils/theme";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { BarChart, LineChart, PieChart } from "react-native-gifted-charts";
import { Ionicons } from "@expo/vector-icons";

export const CHART_COLORS = [
  "#5f0909",
  "#b86b1d",
  "#356a59",
  "#a8583a",
  "#8f1d2c",
  "#d39a32",
  "#6d5a48",
  "#56816d",
  "#9d6251",
  "#6d4147",
];

export type LinePoint = { value: number; label?: string };
export type NamedValue = { label: string; value: number };

function EmptyChart({ note }: { note: string }) {
  const { styles } = useStyles();
  return (
    <View style={styles.emptyBox}>
      <Ionicons name="bar-chart-outline" size={22} color={styles.emptyText.color} />
      <Text style={styles.emptyText}>{note}</Text>
    </View>
  );
}

/** Line — daily active users from dailyStats. `data` is oldest→newest. */
export function DailyActiveUsersLine({
  data,
  rangeDays,
  animate = true,
}: {
  data: LinePoint[];
  rangeDays: number;
  animate?: boolean;
}) {
  const { styles, theme } = useStyles();
  const { width } = useWindowDimensions();
  const chartWidth = Math.max(120, width - 96);
  if (!data.some((point) => point.value > 0)) {
    return <EmptyChart note="No rollup data for this range yet." />;
  }
  const maxValue = Math.max(4, ...data.map((point) => point.value));
  const spacing =
    data.length > 1 ? (chartWidth - 34) / (data.length - 1) : chartWidth / 2;

  return (
    <View style={styles.chartClip}>
      <LineChart
        data={data}
        width={chartWidth}
        height={170}
        thickness={2.5}
        color={theme.success}
        areaChart
        curved
        isAnimated={animate}
        animationDuration={550}
        startFillColor={theme.success}
        endFillColor={theme.success}
        startOpacity={0.18}
        endOpacity={0.02}
        hideDataPoints={rangeDays > 10}
        dataPointsColor={theme.success}
        dataPointsRadius={3}
        initialSpacing={12}
        endSpacing={8}
        spacing={spacing}
        noOfSections={4}
        maxValue={Math.ceil(maxValue * 1.15)}
        yAxisThickness={0}
        xAxisColor={theme.border}
        rulesColor={theme.border}
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
  animate = true,
}: {
  data: NamedValue[];
  color?: string;
  emptyNote?: string;
  animate?: boolean;
}) {
  const { styles, theme } = useStyles();
  const { width } = useWindowDimensions();
  const chartWidth = Math.max(120, width - 96);
  const rows = useMemo(() => data.filter((row) => row.value > 0), [data]);
  if (rows.length === 0) return <EmptyChart note={emptyNote} />;

  const maxValue = Math.max(1, ...rows.map((row) => row.value));
  return (
    <View>
      <View style={styles.chartClip}>
        <BarChart
          horizontal
          isAnimated={animate}
          animationDuration={500}
          data={rows.map((row) => ({
            value: row.value,
            label: row.label,
            frontColor: color,
          }))}
          barWidth={16}
          spacing={18}
          height={Math.max(120, rows.length * 40)}
          width={Math.max(70, chartWidth - 90)}
          initialSpacing={6}
          noOfSections={3}
          maxValue={Math.ceil(maxValue * 1.15)}
          yAxisThickness={0}
          xAxisColor={theme.border}
          rulesColor={theme.border}
          yAxisLabelWidth={84}
          yAxisTextStyle={styles.axisTextSmall}
          xAxisLabelTextStyle={styles.axisTextSmall}
          barBorderRadius={3}
        />
      </View>
      <View style={styles.categoryList}>
        {data.map((row) => (
          <View key={row.label} style={styles.categoryListRow} accessibilityLabel={`${row.label}: ${row.value}`}>
            <View style={[styles.categoryListMark, { backgroundColor: color }]} />
            <Text style={styles.categoryListLabel} numberOfLines={2}>{row.label}</Text>
            <Text style={styles.categoryListValue}>{row.value.toLocaleString()}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Donut + manual legend. `data` is {label, value}; colors from CHART_COLORS. */
export function DistributionDonut({
  data,
  emptyNote = "No data yet.",
  animate = true,
}: {
  data: NamedValue[];
  emptyNote?: string;
  animate?: boolean;
}) {
  const { styles, theme } = useStyles();
  const { width } = useWindowDimensions();
  const rows = data.map((row, index) => ({
      ...row,
      color: CHART_COLORS[index % CHART_COLORS.length],
  }));

  const total = rows.reduce((sum, row) => sum + row.value, 0);
  if (total === 0) return <EmptyChart note={emptyNote} />;

  return (
    <View style={[styles.donutRow, width < 440 && styles.donutRowStacked]}>
      <View style={width < 440 ? styles.donutCenterChart : undefined}>
        <PieChart
          donut
          isAnimated={animate}
          animationDuration={520}
          radius={64}
          innerRadius={40}
          data={rows.filter((row) => row.value > 0).map((row) => ({ value: row.value, color: row.color }))}
          innerCircleColor={theme.surface}
          centerLabelComponent={() => (
            <View style={styles.donutCenter}>
              <Text style={styles.donutCenterValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{total.toLocaleString()}</Text>
              <Text style={styles.donutCenterLabel}>total</Text>
            </View>
          )}
        />
      </View>
      <View style={[styles.legend, width < 440 && styles.legendStacked]}>
        {rows.map((row) => (
          <View key={row.label} style={styles.legendRow}>
            <View style={[styles.legendSwatch, { backgroundColor: row.color }]} />
            <Text style={styles.legendLabel} numberOfLines={2}>
              {row.label}
            </Text>
            <Text style={styles.legendValue}>
              {row.value.toLocaleString()} · {Math.round((row.value / total) * 100)}%
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (c: ThemeTokens) =>
  StyleSheet.create({
  chartClip: { overflow: "hidden", marginTop: 14, width: "100%" },
  categoryList: { gap: 5, marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: c.border },
  categoryListRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 },
  categoryListMark: { width: 7, height: 7, borderRadius: 4 },
  categoryListLabel: { flex: 1, minWidth: 0, color: c.textSecondary, fontSize: 12 },
  categoryListValue: { color: c.textPrimary, fontSize: 12, fontWeight: "700" },
  axisText: { color: c.textMuted, fontSize: 11 },
  axisTextSmall: { color: c.textMuted, fontSize: 10.5 },
  emptyBox: {
    minHeight: 120,
    paddingVertical: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  emptyText: { color: c.textMuted, fontSize: 12.5, textAlign: "center" },
  donutRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    marginTop: 14,
  },
  donutRowStacked: { flexDirection: "column", alignItems: "stretch" },
  donutCenterChart: { width: "100%", alignItems: "center" },
  donutCenter: { alignItems: "center" },
  donutCenterValue: { color: c.textPrimary, fontSize: 18, fontWeight: "700", maxWidth: 72 },
  donutCenterLabel: { color: c.textMuted, fontSize: 11 },
  legend: { flex: 1, minWidth: 0, gap: 7 },
  legendStacked: { width: "100%" },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 },
  legendSwatch: { width: 11, height: 11, borderRadius: 3 },
  legendLabel: { flex: 1, minWidth: 0, color: c.textPrimary, fontSize: 12, fontWeight: "600" },
  legendValue: { color: c.textMuted, fontSize: 11, fontWeight: "700", flexShrink: 0 },
});

export default function AnalyticsChartsRoutePlaceholder() {
  return null;
}

/** Themed stylesheet for this screen. */
const useStyles = () => {
  const theme = useThemeColors();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return useMemo(() => ({ styles, theme }), [styles, theme]);
};
