import { useState, useEffect, useRef, useCallback } from "react";
import { Link } from "react-router-dom";
import Hls from "hls.js";
import { apiClient } from "@/services/api";
import { fetchVideoStreamUrl, mapMovieToTitle } from "@/lib/movies";
import type { Title } from "@/lib/mock-data";
import type { BackendMovie } from "@/store/slices/moviesSlice";
import { useSocketEvent } from "@/hooks/useSocket";
import { SOCKET_EVENTS } from "@/lib/socket";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RatingBadge } from "./RatingBadge";
import {
  Play,
  Info,
  Star,
  Clock,
  Volume2,
  VolumeX,
  ChevronLeft,
  ChevronRight,
  Hd,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([^?&\s]+)/,
    /youtube\.com\/watch\?v=([^&\s]+)/,
    /youtube\.com\/embed\/([^?&\s]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function videoType(url: string): "hls" | "direct" | "youtube" | "none" {
  if (!url) return "none";
  if (extractYouTubeId(url)) return "youtube";
  if (url.includes(".m3u8") || url.includes("/hls/")) return "hls";
  if (url.match(/\.(mp4|webm|ogg|mov)(\?|$)/i)) return "direct";
  return "none";
}

// ── Background Video ──────────────────────────────────────────────────────────

interface BgVideoProps {
  src: string;
  poster: string;
  muted: boolean;
}

function BgVideo({ src, poster, muted }: BgVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const type = videoType(src);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let observer: IntersectionObserver | null = null;
    if (window.IntersectionObserver) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            setVisible(entry.isIntersecting);
          });
        },
        { threshold: 0.05 }
      );
      observer.observe(video);
    } else {
      setVisible(true);
    }

    return () => {
      if (observer) {
        observer.unobserve(video);
        observer.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!visible) {
      video.pause();
      if (hlsRef.current) {
        hlsRef.current.stopLoad();
      }
      return;
    }

    if (hlsRef.current) {
      hlsRef.current.startLoad();
      video.play().catch(() => {});
      return;
    }

    if (type === "hls" && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        autoStartLoad: true,
        capLevelToPlayerSize: false,
        startLevel: -1,
        maxBufferLength: 20, // Optimized down from 60
        maxBufferSize: 30 * 1024 * 1024, // Optimized down from 120MB
        maxMaxBufferLength: 40,
        abrEwmaDefaultEstimate: 8_000_000,
        testBandwidth: false,
      });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (hls.levels && hls.levels.length > 0) {
          const top = hls.levels.length - 1;
          hls.currentLevel = top;
          hls.loadLevel = top;
          hls.nextLevel = top;
        }
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_SWITCHING, (_, data) => {
        if (hls.levels && data.level < hls.levels.length - 1) {
          hls.nextLevel = hls.levels.length - 1;
        }
      });

      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal) hls.recoverMediaError();
      });
    } else if (
      type === "hls" &&
      video.canPlayType("application/vnd.apple.mpegurl")
    ) {
      video.src = src;
      video.load();
      video.play().catch(() => {});
    } else if (type === "direct") {
      video.src = src;
      video.load();
      video.play().catch(() => {});
    } else {
      video.src = "";
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, type, visible]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  if (type === "none") return null;

  if (type === "youtube") {
    const ytId = extractYouTubeId(src);
    if (!ytId) return null;
    return (
      <div className="absolute inset-0 w-full h-full pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
        <iframe
          src={`https://www.youtube.com/embed/${ytId}?autoplay=1&mute=${muted ? 1 : 0}&loop=1&playlist=${ytId}&controls=0&showinfo=0&rel=0&modestbranding=1&playsinline=1`}
          className="absolute inset-0 w-[120%] h-[120%] -top-[10%] -left-[10%] object-cover"
          style={{ border: "none", pointerEvents: "none" }}
          allow="autoplay; encrypted-media"
        />
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      muted={muted}
      loop
      playsInline
      autoPlay
      poster={poster}
      className="absolute inset-0 w-full h-full object-cover"
      style={{ zIndex: 0 }}
    />
  );
}

// ── Thumbnail Card ────────────────────────────────────────────────────────────

interface ThumbCardProps {
  title: Title;
  active: boolean;
  progress: number;
  onClick: () => void;
}

function ThumbCard({ title, active, progress, onClick }: ThumbCardProps) {
  return (
    <button
      onClick={onClick}
      className={`group relative shrink-0 overflow-hidden rounded-xl transition-all duration-500 ease-out border ${
        active
          ? "border-primary shadow-[0_0_24px_rgba(192,57,43,0.45)] scale-[1.08] opacity-100 relative z-10"
          : "border-white/5 opacity-50 hover:opacity-90 hover:scale-[1.04]"
      }`}
      style={{ width: "clamp(76px, 9.5vw, 115px)", aspectRatio: "2/3" }}
    >
      <img
        src={title.posterUrl}
        alt={title.name}
        className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 ease-out group-hover:scale-110"
        onError={(e) => {
          (e.target as HTMLImageElement).src =
            `https://picsum.photos/seed/${title.id}/110/165`;
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/30 to-black/5 transition-all duration-300 group-hover:from-black/100" />
      <div className="absolute inset-x-0 bottom-0 p-2.5">
        <p className="text-[10px] font-bold text-white leading-tight line-clamp-2 drop-shadow">
          {title.name}
        </p>
      </div>
      {active && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
          <div
            className="h-full bg-gradient-to-r from-primary to-amber-500 transition-none shadow-[0_0_8px_rgba(192,57,43,0.8)]"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </button>
  );
}

// ── Hero ──────────────────────────────────────────────────────────────────────

const ROTATE_MS = 7000;
const FALLBACK_MOVIES: Title[] = [];

const resolvedUrlCache = new Map<string, string>();

export function Hero() {
  const [movies, setMovies] = useState<Title[]>(FALLBACK_MOVIES);
  const [activeIdx, setActiveIdx] = useState(0);
  const [videoBgMuted, setVideoBgMuted] = useState(true);
  const [progress, setProgress] = useState(0);
  const [resolvedVideoUrl, setResolvedVideoUrl] = useState<string>("");
  const [contentKey, setContentKey] = useState(0);

  const progressRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const lastFetchedId = useRef<string>("");

  const fetchBannerMovies = useCallback(() => {
    apiClient
      .get("/movies?status=published&is_banner=true&limit=10")
      .then(({ data }) => {
        let fetched: Title[] = (data.data.movies as BackendMovie[])
          .map(mapMovieToTitle)
          .filter((t) => t.backdropUrl || t.posterUrl);

        if (fetched.length >= 1) {
          setMovies(fetched);
          return;
        }

        // Fallback: fetch default published movies if no banner movies are set
        apiClient
          .get("/movies?status=published&limit=8")
          .then(({ data: fallbackData }) => {
            fetched = (fallbackData.data.movies as BackendMovie[])
              .map(mapMovieToTitle)
              .filter((t) => t.backdropUrl || t.posterUrl);
            if (fetched.length >= 2) setMovies(fetched.slice(0, 6));
            if (fetched.length > 0) {
              const targetIndex = fetched
                .slice(0, 6)
                .findIndex((movie) => movie.id === "10");
              if (targetIndex !== -1) {
                setActiveIdx(targetIndex);
              }
            }
          })
          .catch(() => {});
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchBannerMovies();
  }, [fetchBannerMovies]);

  useSocketEvent(SOCKET_EVENTS.MOVIE_CREATED, fetchBannerMovies);
  useSocketEvent(SOCKET_EVENTS.MOVIE_UPDATED, fetchBannerMovies);
  useSocketEvent(SOCKET_EVENTS.MOVIE_DELETED, fetchBannerMovies);

  const safeIdx =
    movies.length > 0 ? Math.min(activeIdx, movies.length - 1) : 0;
  const current = movies[safeIdx];

  useEffect(() => {
    if (!current?.id || !current?.hlsUrl) {
      setResolvedVideoUrl("");
      return;
    }

    if (lastFetchedId.current === current.id) return;
    lastFetchedId.current = current.id;

    if (resolvedUrlCache.has(current.id)) {
      setResolvedVideoUrl(resolvedUrlCache.get(current.id)!);
      return;
    }

    setResolvedVideoUrl("");

    let cancelled = false;

    if (current.hlsUrl.includes("/uploads/videos/") || current.hlsUrl.includes("/uploads/hls/")) {
      fetchVideoStreamUrl(current.id)
        .then((url) => {
          if (!cancelled && url) {
            resolvedUrlCache.set(current.id, url);
            setResolvedVideoUrl(url);
          }
        })
        .catch(() => {});
    } else {
      resolvedUrlCache.set(current.id, current.hlsUrl);
      setResolvedVideoUrl(current.hlsUrl);
    }

    return () => {
      cancelled = true;
    };
  }, [current?.id]);

  const startTicker = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    startRef.current = null;
    progressRef.current = 0;
    setProgress(0);
    setContentKey((k) => k + 1);

    const tick = (ts: number) => {
      if (pausedRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const pct = Math.min((elapsed / ROTATE_MS) * 100, 100);
      progressRef.current = pct;
      setProgress(pct);
      if (pct < 100) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setActiveIdx((prev) => (prev + 1) % movies.length);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [movies.length]);

  useEffect(() => {
    startTicker();
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [activeIdx, startTicker]);

  const goTo = (idx: number) => {
    if (idx === activeIdx) return;
    setActiveIdx(idx);
  };

  const goPrev = () => goTo((activeIdx - 1 + movies.length) % movies.length);
  const goNext = () => goTo((activeIdx + 1) % movies.length);

  const effectiveVideoUrl = resolvedVideoUrl;
  const hasVideo =
    !!effectiveVideoUrl &&
    videoType(effectiveVideoUrl) !== "none";

  if (!current) {
    return (
      <section
        className="relative -mt-16 w-full overflow-hidden bg-[#080810]"
        style={{ height: "clamp(560px, 82vh, 900px)" }}
      />
    );
  }

  return (
    <section
      className="relative -mt-16 w-full overflow-hidden"
      style={{ height: "clamp(560px, 82vh, 900px)" }}
      onMouseEnter={() => {
        pausedRef.current = true;
      }}
      onMouseLeave={() => {
        pausedRef.current = false;
      }}
    >
      {/* Background poster with smooth crossfade */}
      <img
        key={`poster-${current.id}`}
        src={current.backdropUrl || current.posterUrl}
        alt={current.name}
        className="absolute inset-0 w-full h-full object-cover animate-fade-in"
        style={{ zIndex: 0 }}
      />

      {/* HD Video overlay */}
      {hasVideo && (
        <BgVideo
          key={`video-${current.id}`}
          src={effectiveVideoUrl}
          poster={current.backdropUrl}
          muted={videoBgMuted}
        />
      )}

      {/* Cinematic gradient layers */}
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            "linear-gradient(to right, rgba(0,0,0,0.96) 0%, rgba(0,0,0,0.65) 45%, rgba(0,0,0,0.15) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.98) 0%, rgba(0,0,0,0.40) 35%, transparent 65%)",
        }}
      />
      {/* Subtle top fade for navbar blend */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-36"
        style={{
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, transparent 100%)",
        }}
      />

      {/* Stage spotlights for Toy Story 5 */}
      {current.name === "Toy Story 5" && (
        <div className="hero-spotlights pointer-events-none absolute inset-0 z-10 overflow-hidden">
          <div className="hero-spotlight-bulb-1" />
          <div className="hero-spotlight-bulb-2" />
          <div className="hero-spotlight-1" />
          <div className="hero-spotlight-2" />
        </div>
      )}

      {/* HD / Video quality badge */}
      {hasVideo && (
        <div className="absolute top-24 right-8 z-30 flex items-center gap-2 rounded-full border border-white/10 bg-black/60 px-3.5 py-1.5 backdrop-blur-xl shadow-2xl">
          <Hd className="size-4 text-white/80" />
          <span className="text-[10px] font-extrabold uppercase tracking-widest text-white/70">
            Live Stream
          </span>
          <span className="size-2 rounded-full bg-primary animate-glow-pulse" />
        </div>
      )}

      {/* Main content */}
      <div className="relative z-20 flex h-full max-w-full flex-col justify-between px-4 pb-6 pt-20 sm:px-8 sm:pt-24">
        {/* Hero text + actions */}
        <div
          key={`content-${contentKey}`}
          className="flex flex-1 flex-col justify-center max-w-2xl mt-4 animate-hero-in"
        >
          {/* Badges row */}
          <div className="flex flex-wrap items-center gap-2 mb-4 sm:mb-6">
            {current.name === "Toy Story 5" ? (
              <>
                <span className="inline-flex items-center rounded-full bg-red-600 px-3.5 py-1 text-[10px] font-black text-white uppercase tracking-widest shadow-[0_0_12px_rgba(220,38,38,0.4)]">
                  Kids and Family
                </span>
                <span className="inline-flex items-center rounded-full border border-red-500/30 bg-red-950/20 px-3.5 py-1 text-[10px] font-black text-red-400 uppercase tracking-widest backdrop-blur-md">
                  Kids Special
                </span>
              </>
            ) : (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-3.5 py-1 text-xs font-black text-primary uppercase tracking-widest backdrop-blur-md shadow-[0_0_16px_rgba(192,57,43,0.15)]">
                  ✦ Featured
                </span>
                {current.newRelease && (
                  <Badge className="bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[10px] font-black uppercase tracking-wider rounded-full px-2.5">
                    New Release
                  </Badge>
                )}
                {current.trending && (
                  <Badge className="bg-orange-500/10 text-orange-300 border border-orange-500/30 text-[10px] font-black uppercase tracking-wider rounded-full px-2.5">
                    Trending
                  </Badge>
                )}
              </>
            )}
          </div>

          {/* Title */}
          <h1
            className="text-4xl font-black leading-none tracking-tight text-white sm:text-5xl lg:text-[4rem] drop-shadow-2xl"
            style={{ textShadow: "0 2px 40px rgba(0,0,0,0.95)" }}
          >
            {current.name}
          </h1>

          {/* Meta row */}
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:gap-3 text-xs sm:text-sm">
            {current.rating > 0 && <RatingBadge rating={current.rating} />}
            <span className="text-white/60 font-semibold">{current.year}</span>
            {current.durationMin > 0 && (
              <span className="inline-flex items-center gap-1 text-white/60">
                <Clock className="size-3.5 shrink-0" /> {current.durationMin}m
              </span>
            )}
            <Badge
              variant="secondary"
              className="bg-white/5 text-white/80 border border-white/10 font-bold text-[10px] backdrop-blur-xl px-2.5 py-0.5 rounded-md"
            >
              {current.maturity}
            </Badge>
            {current.genres.length > 0 && (
              <span className="text-white/50 text-xs font-medium">
                {current.genres.join(" · ")}
              </span>
            )}
          </div>

          {/* Synopsis */}
          {current.synopsis && (
            <p className="mt-3 sm:mt-4 max-w-lg text-sm leading-relaxed text-white/85 line-clamp-3 sm:text-base font-normal">
              {current.synopsis}
            </p>
          )}

          {/* Cast */}
          {current.cast.length > 0 && (
            <p className="mt-3 text-xs text-white/40 font-medium">
              <span className="text-white/55 font-bold">Starring: </span>
              {current.cast.slice(0, 3).join(", ")}
            </p>
          )}

          {/* Action buttons */}
          <div className="mt-6 sm:mt-8 flex items-center gap-3 w-full sm:w-auto">
            <Button
              size="lg"
              className="relative group overflow-hidden bg-white text-black hover:bg-white/90 font-extrabold gap-1.5 sm:gap-2 flex-1 sm:flex-initial px-4 sm:px-8 py-4 sm:py-6 h-auto rounded-lg sm:rounded-xl transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] shadow-[0_4px_24px_rgba(255,255,255,0.15)] text-sm sm:text-base cursor-pointer"
              asChild
            >
              <Link to={`/watch/${current.id}`}>
                <span className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-black/[0.02] to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" />
                <Play className="size-4 sm:size-5 fill-black text-black" /> Play
              </Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="bg-white/5 hover:bg-white/10 text-white border border-white/15 backdrop-blur-md gap-1.5 sm:gap-2 flex-1 sm:flex-initial px-4 sm:px-8 py-4 sm:py-6 h-auto rounded-lg sm:rounded-xl transition-all duration-300 hover:scale-[1.02] active:scale-[0.98] text-sm sm:text-base cursor-pointer"
              asChild
            >
              <Link to={`/watch/${current.id}`}>
                <Info className="size-4 sm:size-5" /> More Info
              </Link>
            </Button>

            {/* Sound toggle */}
            {hasVideo && (
              <button
                onClick={() => setVideoBgMuted((v) => !v)}
                className="flex size-10 sm:size-12 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/40 backdrop-blur-md text-white hover:bg-white/20 hover:scale-105 active:scale-95 transition-all cursor-pointer"
                aria-label={videoBgMuted ? "Unmute" : "Mute"}
              >
                {videoBgMuted ? (
                  <VolumeX className="size-4 sm:size-5 text-white/70" />
                ) : (
                  <Volume2 className="size-4 sm:size-5 text-white" />
                )}
              </button>
            )}
          </div>
        </div>

        {/* Bottom bar — thumbnails + nav controls */}
        {movies.length > 1 && (
          <div className="flex items-end justify-between sm:justify-start gap-4">
            {/* Thumbnail strip */}
            <div className="hidden sm:flex items-end gap-2.5 overflow-x-auto scrollbar-none pb-2">
              {movies.map((m, idx) => (
                <ThumbCard
                  key={m.id}
                  title={m}
                  active={idx === activeIdx}
                  progress={idx === activeIdx ? progress : 0}
                  onClick={() => goTo(idx)}
                />
              ))}
            </div>

            {/* Mobile dot indicators */}
            <div className="flex sm:hidden items-center gap-1.5 pb-1">
              {movies.slice(0, 6).map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => goTo(idx)}
                  className={`rounded-full transition-all duration-300 ${
                    idx === activeIdx
                      ? "w-6 h-2 bg-primary shadow-[0_0_8px_rgba(192,57,43,0.7)]"
                      : "size-2 bg-white/30 hover:bg-white/50"
                  }`}
                />
              ))}
            </div>

            {/* Nav arrows — visible on both desktop and mobile, positioned at the bottom right */}
            <div className="flex items-center gap-2 shrink-0 pb-2">
              <button
                onClick={goPrev}
                className="flex size-10 sm:size-11 items-center justify-center rounded-full border border-white/10 bg-black/40 backdrop-blur-md text-white hover:bg-white/20 transition-all hover:scale-105 active:scale-90 active:border-primary/50 active:shadow-[0_0_12px_rgba(192,57,43,0.4)] cursor-pointer"
                aria-label="Previous"
              >
                <ChevronLeft className="size-4 sm:size-5" />
              </button>
              <button
                onClick={goNext}
                className="flex size-10 sm:size-11 items-center justify-center rounded-full border border-white/10 bg-black/40 backdrop-blur-md text-white hover:bg-white/20 transition-all hover:scale-105 active:scale-90 active:border-primary/50 active:shadow-[0_0_12px_rgba(192,57,43,0.4)] cursor-pointer"
                aria-label="Next"
              >
                <ChevronRight className="size-4 sm:size-5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom progress bar */}
      <div className="absolute inset-x-0 bottom-0 z-30 h-[2.5px] bg-white/5">
        <div
          className="h-full bg-gradient-to-r from-primary via-red-500 to-amber-500 transition-none shadow-[0_0_8px_rgba(192,57,43,0.8)]"
          style={{ width: `${progress}%` }}
        />
      </div>
    </section>
  );
}
