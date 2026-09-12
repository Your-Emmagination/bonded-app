import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Keyboard, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { ChatGif, fetchChatGifs } from "@/utils/giphy";

export default function ChatGifPicker({ onClose, onSelect, color }: {
  onClose: () => void; onSelect: (gif: ChatGif) => void; color: string;
}) {
  const [search, setSearch] = useState("");
  const [gifs, setGifs] = useState<ChatGif[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [selected, setSelected] = useState<ChatGif | null>(null);
  const request = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    inFlight.current = true;
    // Reset the displayed page when replacing the external API request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(""); setGifs([]); setHasMore(false);
    nextOffset.current = 0;
    const timer = setTimeout(() => {
      void fetchChatGifs(search, 0, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        setGifs(result.gifs); setHasMore(result.hasMore); nextOffset.current = result.nextOffset;
      }).catch((e) => { if (!controller.signal.aborted) setError(e.message || "Couldn't load GIFs."); })
        .finally(() => { if (!controller.signal.aborted) { setLoading(false); inFlight.current = false; } });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, retry]);
  const loadMore = async () => {
    if (inFlight.current || !hasMore || error) return;
    const controller = request.current;
    if (!controller || controller.signal.aborted) return;
    inFlight.current = true; setLoading(true);
    try {
      const result = await fetchChatGifs(search, nextOffset.current, controller.signal);
      if (controller.signal.aborted) return;
      setGifs((previous) => [...previous, ...result.gifs.filter((gif) => !previous.some((old) => old.id === gif.id))]);
      setHasMore(result.hasMore); nextOffset.current = result.nextOffset;
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load GIFs."); }
    finally { if (!controller.signal.aborted) { inFlight.current = false; setLoading(false); } }
  };
  return <Modal visible animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen">
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>{selected ? "Preview GIF" : "GIFs"}</Text>
        <Pressable onPress={onClose} style={styles.button} accessibilityLabel="Close GIF picker" accessibilityRole="button"><Ionicons name="close" size={25} color={color} /></Pressable>
      </View>
      {selected ? <View style={styles.preview}>
        <Image source={{ uri: selected.url }} style={styles.largeImage} contentFit="contain" accessibilityLabel={selected.title} />
        <Pressable style={[styles.select, { backgroundColor: color }]} onPress={() => onSelect(selected)}><Text style={styles.selectText}>Add to message</Text></Pressable>
        <Pressable style={styles.button} onPress={() => setSelected(null)}><Text style={{ color }}>Choose another GIF</Text></Pressable>
      </View> : <>
        <TextInput value={search} onChangeText={setSearch} maxLength={50} style={styles.search} placeholder="Search GIPHY" placeholderTextColor="#92786f" returnKeyType="search" onSubmitEditing={Keyboard.dismiss} accessibilityLabel="Search GIFs" />
        <Text style={styles.caption}>{search.trim() ? "Search results" : "Trending GIFs"}</Text>
        <FlatList data={gifs} numColumns={2} keyExtractor={(item) => item.id} keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.grid} onEndReached={() => void loadMore()} onEndReachedThreshold={0.4}
          renderItem={({ item }) => <Pressable style={styles.tile} onPress={() => { Keyboard.dismiss(); setSelected(item); }} accessibilityLabel={`Preview ${item.title}`} accessibilityRole="button">
            <Image source={{ uri: item.preview }} style={styles.image} contentFit="contain" />
          </Pressable>}
          ListEmptyComponent={!loading && !error ? <Text style={styles.caption}>No GIFs found. Try another search.</Text> : null}
          ListFooterComponent={loading ? <ActivityIndicator color={color} style={styles.button} /> : null} />
        {!!error && <Pressable style={styles.button} onPress={() => setRetry((value) => value + 1)}><Text style={styles.error}>{error} Tap to retry.</Text></Pressable>}
      </>}
      <View style={styles.attribution}><Image source={require("@/assets/images/giphy-attribution.png")}
        style={{ width: 180, height: 40 }} contentFit="contain" accessibilityLabel="Powered by GIPHY" /></View>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#fffaf7" },
  header: { paddingLeft: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: "#40221d", fontSize: 22, fontWeight: "700" },
  button: { padding: 14, minHeight: 44, alignItems: "center" },
  search: { marginHorizontal: 16, marginTop: 8, borderRadius: 22, backgroundColor: "#f3e9e3", padding: 13, color: "#40221d", fontSize: 16 },
  caption: { padding: 16, color: "#85685f" },
  grid: { paddingHorizontal: 8 },
  tile: { width: "50%", padding: 4 },
  image: { width: "100%", height: 145, backgroundColor: "#f0e8e3", borderRadius: 12 },
  preview: { flex: 1, justifyContent: "center", padding: 20, gap: 16 },
  largeImage: { width: "100%", height: 320 },
  select: { alignItems: "center", padding: 15, borderRadius: 24 },
  selectText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  error: { color: "#8f2117", textAlign: "center" },
  attribution: { alignSelf: "center", margin: 10, paddingHorizontal: 8, borderRadius: 8, backgroundColor: "#181818" },
});
