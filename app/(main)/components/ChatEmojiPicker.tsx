import React, { useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const CATEGORIES = [
  { name: "Smileys", icon: "😊", emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "🙂", "🙃", "😉", "😍", "🥰", "😘", "😋", "😎", "🤩", "🥳", "🤔", "🫡", "🤗", "🤭", "🤫", "😴", "🥹", "🥺", "😢", "😭", "😮", "😬", "😐", "😑", "🙄", "😤", "😡", "🤯", "😱", "🤒", "🤕", "😇", "😈"] },
  { name: "Gestures", icon: "👋", emojis: ["👋", "🤚", "✋", "🖐️", "👌", "🤌", "✌️", "🤞", "🫰", "🤟", "🤘", "🤙", "👍", "👎", "✊", "👊", "👏", "🙌", "👐", "🤲", "🤝", "🙏", "💪", "🫶", "👈", "👉", "👆", "👇"] },
  { name: "Hearts", icon: "❤️", emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "🩷", "🩵", "🩶", "💔", "❤️‍🩹", "❤️‍🔥", "💕", "💞", "💓", "💗", "💖", "💘", "💝", "💟", "❣️", "💯", "💫", "⭐", "🌟", "✨", "🔥", "🎉", "🎊", "🎈", "🎁", "🏆"] },
  { name: "Nature", icon: "🐱", emojis: ["🐶", "🐱", "🐭", "🐹", "🐰", "🦊", "🐻", "🐼", "🐨", "🐯", "🦁", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🦋", "🐝", "🐢", "🐬", "🐳", "🌸", "🌷", "🌹", "🌻", "🌼", "🌱", "🌿", "🍀", "🌴", "🌈", "☀️", "🌙", "☁️", "🌧️", "❄️", "🌊", "🌎", "🍁", "🌺", "🌵"] },
  { name: "Food", icon: "🍔", emojis: ["🍎", "🍓", "🍒", "🍉", "🍌", "🍍", "🥭", "🥑", "🍞", "🥐", "🥞", "🧀", "🍗", "🍔", "🍟", "🍕", "🌭", "🥪", "🌮", "🍜", "🍝", "🍚", "🍣", "🍤", "🍦", "🍩", "🍪", "🎂", "🍰", "🍫", "🍬", "☕", "🧋", "🥤", "🧃"] },
  { name: "Things", icon: "⚽", emojis: ["⚽", "🏀", "🏐", "🏸", "🎮", "🎲", "🎯", "🎸", "🎹", "🎵", "🎧", "🎤", "🎬", "📷", "📱", "💻", "💡", "📚", "📖", "✏️", "📝", "🎓", "📌", "📅", "⏰", "🏠", "🏫", "🚗", "🚌", "✈️", "🚀", "✅", "❌", "❓", "❗"] },
];

export default function ChatEmojiPicker({ onSelect, onClose, onOpenGifs, disabled, color, bottomInset }: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  onOpenGifs?: () => void;
  disabled: boolean;
  color: string;
  bottomInset: number;
}) {
  const [category, setCategory] = useState(0);
  return (
    <View style={[styles.panel, { paddingBottom: Math.max(bottomInset, 8) }]} accessibilityLabel="Emoji picker">
      <View style={styles.heading}>
        <Text style={styles.title}>{CATEGORIES[category].name}</Text>
        {onOpenGifs && <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel="Open GIF picker" onPress={onOpenGifs} style={styles.close}>
          <Text style={[styles.title, { color }]}>GIF</Text>
        </Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel="Close emoji picker" onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={20} color="#7a554e" />
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.categories}>
        {CATEGORIES.map((item, index) => (
          <Pressable key={item.name} onPress={() => setCategory(index)} accessibilityRole="tab"
            accessibilityLabel={item.name} accessibilityState={{ selected: index === category }}
            style={[styles.category, index === category && { borderBottomColor: color }]}>
            <Text style={styles.categoryIcon}>{item.icon}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <FlatList key={category} data={CATEGORIES[category].emojis} numColumns={7} keyExtractor={(emoji) => emoji}
        keyboardShouldPersistTaps="always" style={styles.grid} contentContainerStyle={styles.gridContent}
        renderItem={({ item }) => (
          <Pressable disabled={disabled} onPress={() => onSelect(item)} accessibilityRole="button"
            accessibilityLabel={`Insert ${item}`} style={({ pressed }) => [styles.emoji, pressed && styles.pressed]}>
            <Text style={styles.emojiText}>{item}</Text>
          </Pressable>
        )} />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#fffaf7", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e4d5cd" },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: 16 },
  title: { fontSize: 13, fontWeight: "600", color: "#7a554e" },
  close: { minWidth: 44, minHeight: 40, alignItems: "center", justifyContent: "center" },
  categories: { flexGrow: 0, height: 44 },
  category: { width: 52, height: 44, alignItems: "center", justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  categoryIcon: { fontSize: 23 },
  grid: { height: 180, flexGrow: 0 },
  gridContent: { paddingHorizontal: 8 },
  emoji: { width: "14.2857%", height: 44, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  emojiText: { fontSize: 27 },
  pressed: { backgroundColor: "#f2e7e1" },
});
