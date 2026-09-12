// Reuse the app's existing public GIPHY client key; builds may override it through Expo.
const GIPHY_KEY = process.env.EXPO_PUBLIC_GIPHY_API_KEY || "UAisLETyclXOiTF4eGtbxACJ3VM3hv6G";
export type ChatGif = { id: string; title: string; url: string; preview: string };

export async function fetchChatGifs(search: string, offset = 0, signal?: AbortSignal) {
  const parameters = new URLSearchParams({ api_key: GIPHY_KEY, limit: "24", offset: String(offset), rating: "pg" });
  if (search.trim()) parameters.set("q", search.trim());
  const response = await fetch(`https://api.giphy.com/v1/gifs/${search.trim() ? "search" : "trending"}?${parameters}`, { signal });
  if (!response.ok) throw new Error(response.status === 429 ? "GIFs are busy. Please try again shortly." : "Couldn't load GIFs. Please try again.");
  const body = await response.json();
  const gifs: ChatGif[] = (body.data || []).map((item: any) => ({
    id: item.id, title: item.title || "GIF", url: item.images.original.url,
    preview: item.images.fixed_width?.url || item.images.original.url,
  }));
  const nextOffset = offset + gifs.length;
  return { gifs, nextOffset, hasMore: gifs.length > 0 && nextOffset < (body.pagination?.total_count || 0) && nextOffset <= (search.trim() ? 4999 : 499) };
}
