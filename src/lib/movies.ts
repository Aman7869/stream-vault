import { apiClient, assetUrl } from "@/services/api";
import type { Title } from "@/lib/mock-data";
import type { BackendMovie } from "@/store/slices/moviesSlice";

export function resolveBunnyHlsUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.includes("/playlist.m3u8")) return url;
  
  if (url.includes("mediadelivery.net/embed/")) {
    try {
      const parsedUrl = new URL(url);
      const pathParts = parsedUrl.pathname.split('/'); // ["", "embed", "libraryId", "videoId"]
      const videoId = pathParts[3];
      if (videoId) {
        const queryParams = parsedUrl.search;
        return `https://vz-8fee5f3f-6e6.b-cdn.net/${videoId}/playlist.m3u8${queryParams}`;
      }
    } catch (e) {
      console.error("Error parsing Bunny embed URL:", e);
    }
  }
  return url;
}

export function mapMovieToTitle(movie: BackendMovie): Title {
  const year = movie.release_date
    ? new Date(movie.release_date).getFullYear()
    : 2024;
  const hue =
    Array.from(movie.title).reduce((acc, ch) => acc + ch.charCodeAt(0), 0) %
    360;

  let poster = movie.thumbnail_url
    ? assetUrl(movie.thumbnail_url)
    : `https://picsum.photos/seed/${movie.slug ?? movie.id}/342/513`;

  let backdrop = movie.thumbnail_url
    ? assetUrl(movie.thumbnail_url)
    : `https://picsum.photos/seed/${movie.slug ?? movie.id}-bg/780/440`;

  // Custom high-quality assets and details for Toy Story 5
  if (movie.title === "Toy Story 5") {
    poster = "https://image.tmdb.org/t/p/w500/rhIRbceoE9lR4veEXuwCC2wARtG.jpg";
    backdrop = "https://image.tmdb.org/t/p/original/3Rfvhy1Nl6sSGJwyjb0QiZzZYlB.jpg";
  }

  const categoryName = movie.category?.name ?? "Recommended";
  const genresList: string[] = [];
  if (movie.title === "Toy Story 5") {
    genresList.push("Kids & Family", "Animation", "Adventure");
  } else if (categoryName === "Animation") {
    genresList.push("Animation", "Kids & Family");
  } else if (categoryName === "Action") {
    genresList.push("Action", "Thriller");
  } else if (categoryName === "Comedy") {
    genresList.push("Comedy", "Drama");
  } else if (categoryName === "Horror") {
    genresList.push("Horror", "Mystery");
  } else if (categoryName === "Crime") {
    genresList.push("Crime", "Thriller");
  } else if (categoryName === "TV Shows") {
    genresList.push("Web Series", "Drama");
  } else {
    genresList.push("Drama");
  }

  return {
    id: String(movie.id),
    name: movie.title,
    category: (movie.category?.name ?? "Recommended") as
      | "Trending"
      | "New Releases"
      | "Most Watched"
      | "Recommended",
    genres: genresList,
    year,
    durationMin: movie.duration ? Math.round(movie.duration / 60) : 90,
    maturity: movie.content_rating ?? "PG-13",
    rating: movie.title === "Toy Story 5" ? 8.9 : (movie.rating ? Number(movie.rating) : 0),
    hue,
    synopsis: movie.description ?? "",
    trending: movie.is_featured,
    newRelease: movie.status === "published" && !!movie.release_date &&
      new Date(movie.release_date) > new Date(Date.now() - 30 * 24 * 3600 * 1000),
    posterUrl: poster,
    backdropUrl: backdrop,
    director: "",
    cast: [],
    hlsUrl: movie.video_url ? resolveBunnyHlsUrl(assetUrl(movie.video_url)) : "",
    language: movie.language ?? "English",
    transcoding_status: movie.transcoding_status ?? null,
    content_rating: movie.content_rating ?? null,
    is_age_restricted: movie.is_age_restricted ?? false,
    minimum_age: movie.minimum_age ?? null,
    warning_flags_json: movie.warning_flags_json ?? null,
    subtitle_url: movie.subtitle_url ?? null,
    dubbed_audio_url: movie.dubbed_audio_url ?? null,
    progress: movie.progress !== undefined && movie.progress !== null ? Number(movie.progress) : undefined,
  };
}

export async function fetchMovies(params?: {
  status?: string;
  limit?: number;
  categoryId?: number;
}): Promise<Title[]> {
  const q = new URLSearchParams();
  q.set("status", params?.status ?? "published");
  if (params?.limit) q.set("limit", String(params.limit));
  if (params?.categoryId) q.set("category_id", String(params.categoryId));
  else q.set("limit", "100");
  const { data } = await apiClient.get(`/movies?${q}`);
  return (data.data.movies as BackendMovie[]).map(mapMovieToTitle);
}

export async function fetchMovieById(id: string): Promise<Title | null> {
  try {
    const { data } = await apiClient.get(`/movies/${id}`);
    return mapMovieToTitle(data.data.movie as BackendMovie);
  } catch {
    return null;
  }
}

/**
 * Exchange a movie ID for a short-lived signed stream URL.
 * Only applicable when the movie's video is stored locally on the backend.
 * Returns null if the movie uses an external/CDN video provider.
 */
export async function fetchVideoStreamUrl(movieId: string): Promise<string | null> {
  try {
    const { data } = await apiClient.post(`/videos/token/${movieId}`);
    const streamPath: string = data.data.streamUrl;
    const backendBase = (import.meta.env.VITE_API_URL as string || "http://localhost:5000/api/v1")
      .replace(/\/api\/v1\/?$/, "");
    return `${backendBase}${streamPath}`;
  } catch {
    return null;
  }
}

export async function getMovieProgress(movieId: string): Promise<{ watch_time: number; completion_percentage: number } | null> {
  try {
    const { data } = await apiClient.get(`/progress/movie/${movieId}`);
    return data.data.progress ?? null;
  } catch {
    return null;
  }
}

export async function saveMovieProgress(movieId: string, watchTime: number, duration: number): Promise<void> {
  try {
    await apiClient.put(`/progress/movie/${movieId}`, { watch_time: watchTime, duration });
  } catch {
    // non-critical
  }
}

// ── Interactions (My List + Like) ────────────────────────────────────────────

export interface InteractionStatus {
  is_liked: boolean;
  in_list: boolean;
}

export interface ListItem {
  interaction: { content_type: 'movie' | 'series'; content_id: number; is_liked: boolean; in_list: boolean };
  detail: {
    id: number;
    title: string;
    thumbnail_url: string | null;
    duration?: number | null;
    release_date?: string | null;
    status: string;
  };
}

export async function fetchInteractionStatus(contentType: 'movie' | 'series', contentId: string | number): Promise<InteractionStatus> {
  try {
    const { data } = await apiClient.get(`/interactions/status?content_type=${contentType}&content_id=${contentId}`);
    return data.data as InteractionStatus;
  } catch {
    return { is_liked: false, in_list: false };
  }
}

export async function toggleLike(contentType: 'movie' | 'series', contentId: string | number): Promise<boolean> {
  const { data } = await apiClient.post('/interactions/toggle-like', { content_type: contentType, content_id: Number(contentId) });
  return (data.data as { is_liked: boolean }).is_liked;
}

export async function toggleList(contentType: 'movie' | 'series', contentId: string | number): Promise<boolean> {
  const { data } = await apiClient.post('/interactions/toggle-list', { content_type: contentType, content_id: Number(contentId) });
  return (data.data as { in_list: boolean }).in_list;
}

export async function fetchMyList(): Promise<ListItem[]> {
  const { data } = await apiClient.get('/interactions/my-list');
  return data.data.items as ListItem[];
}

export interface BackendPlan {
  id: number;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  billing_cycle: "monthly" | "yearly";
  stripe_price_id: string | null;
  features_json: string[] | null;
  status: string;
  quality?: string | null;
  max_screens?: number;
}

export async function fetchPlans(): Promise<BackendPlan[]> {
  const { data } = await apiClient.get("/stripe/plans");
  return data.data.plans as BackendPlan[];
}
