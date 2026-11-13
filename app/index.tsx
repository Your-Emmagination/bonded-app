// app/index.tsx
import { useThemeColors } from '@/contexts/ThemeContext';
import { View } from 'react-native';

export default function Index() {
  // Behind the loading screen for a moment: the theme's bar colour, not a
  // fixed maroon, so another theme never flashes red.
  const theme = useThemeColors();
  return <View style={{ flex: 1, backgroundColor: theme.chrome }} />;
}
