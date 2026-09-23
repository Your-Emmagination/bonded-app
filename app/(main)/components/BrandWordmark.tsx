// components/BrandWordmark.tsx
//
// "BondED", set as text with "ED" in the logo's accent colour. The old logo
// image carried its own name — dark navy, invisible on the maroon screens —
// so a second one was typed under it in mint. The mark is now the knot alone
// and the name always comes from here, so it can only appear once.
import { Text, type StyleProp, type TextStyle } from "react-native";

import { BRAND_COLOURWAY } from "@/utils/brand.generated";

type Props = {
  size?: number;
  /** "Bond". Cream by default, for the maroon screens it sits on. */
  color?: string;
  style?: StyleProp<TextStyle>;
};

export default function BrandWordmark({ size = 26, color = "#fffaf6", style }: Props) {
  return (
    <Text
      accessibilityRole="header"
      accessibilityLabel="BondED"
      style={[{ fontSize: size, fontWeight: "800", letterSpacing: -0.4, color }, style]}
    >
      Bond<Text style={{ color: BRAND_COLOURWAY.wordmarkAccent }}>ED</Text>
    </Text>
  );
}
