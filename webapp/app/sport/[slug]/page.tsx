/* app/sport/[slug]/page.tsx – Page de recherche par sport */
"use client";

import { useParams } from "next/navigation";
import { useState, useCallback, useEffect, useRef } from "react";
import Link from "next/link";

interface Sport {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  suggestions: string[];
}

interface Result {
  videoId: string;
  title: string;
  thumbnail: string;
  channel: string;
  startSec: number;
  excerpt: string;
  similarity: number;
  chunkCount: number;
  youtubeUrl: string;
}

function formatTime(sec: number): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getRelevanceLevel(similarity: number, chunkCount: number) {
  const isDeep   = chunkCount >= 4;
  const isMedium = chunkCount >= 2;
  if (similarity >= 80 && isDeep)   return { label: "Sujet principal",  sublabel: "Cette vidéo est entièrement consacrée à ce sujet", level: 4 };
  if (similarity >= 80)             return { label: "Très pertinent",   sublabel: "Ce sujet est traité en détail",                    level: 3 };
  if (similarity >= 65 && isDeep)   return { label: "Très pertinent",   sublabel: "Ce sujet revient plusieurs fois dans la vidéo",    level: 3 };
  if (similarity >= 65 || (similarity >= 55 && isMedium))
                                    return { label: "Pertinent",        sublabel: "Ce sujet est abordé dans la vidéo",                level: 2 };
  return                                   { label: "Mentionné",        sublabel: "Ce sujet est effleuré en passant",                 level: 1 };
}

const LEVEL_COLOR: Record<number, string> = {
  1: "#9ca3af", 2: "#60a5fa", 3: "#4ade80", 4: "#e8ff47",
};

function RelevanceBadge({ similarity, chunkCount }: { similarity: number; chunkCount: number }) {
  const { label, sublabel, level } = getRelevanceLevel(similarity, chunkCount);
  const color = LEVEL_COLOR[level];
  return (
    <div className="relevance-badge">
      <div className="relevance-dots">
        {[1, 2, 3, 4].map((l) => (
          <span key={l} className="relevance-dot"
            style={{ background: l <= level ? color : "#e5e7eb" }} />
        ))}
      </div>
      <div className="relevance-text">
        <span className="relevance-label" style={{ color }}>{label}</span>
        <span className="relevance-sub">{sublabel}</span>
      </div>
    </div>
  );
}

function ResultCard({ r, index }: { r: Result; index: number }) {
  return (
    <a href={r.youtubeUrl} target="_blank" rel="noopener noreferrer"
      className="result-card" style={{ animationDelay: `${index * 55}ms` }}>
      <div className="card-thumb">
        <img src={r.thumbnail} alt={r.title} loading="lazy" />
        {r.startSec > 0 && <span className="timestamp-badge">{formatTime(r.startSec)}</span>}
        <div className="play-overlay">
          <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>
      <div className="card-body">
        <p className="card-channel">{r.channel}</p>
        <h3 className="card-title">{r.title}</h3>
        <p className="card-excerpt">{r.excerpt}</p>
        <RelevanceBadge similarity={r.similarity} chunkCount={r.chunkCount} />
      </div>
    </a>
  );
}

export default function SportPage() {
  const { slug } = useParams<{ slug: string }>();
  const [sport, setSport]     = useState<Sport | null>(null);
  const [query, setQuery]     = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [searched, setSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`/api/sport/${slug}`)
      .then(r => r.json())
      .then(d => setSport(d.sport))
      .catch(() => setSport(null));
  }, [slug]);

  const search = useCallback(async (q: string) => {
    if (!q.trim() || q.trim().length < 2) return;
    setLoading(true); setError(""); setResults([]); setSearched(true);
    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}&sport=${slug}&limit=12`);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Erreur serveur");
      setResults(data.results || []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [slug]);

  const handleKey = (e: React.KeyboardEvent) => { if (e.key === "Enter") search(query); };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --ink: #0a0a0a; --paper: #f7f6f2; --accent: #e8ff47;
          --mid: #6b7280; --line: #e5e4df; --radius: 14px;
        }
        body { font-family: 'DM Sans', sans-serif; background: var(--paper); color: var(--ink); min-height: 100vh; }

        .header {
          background: var(--ink); padding: 16px 32px;
          display: flex; align-items: center; gap: 16px;
        }
        .back-link {
          color: #6b7280; text-decoration: none; font-size: .8rem;
          letter-spacing: .06em; text-transform: uppercase; font-weight: 600;
          display: flex; align-items: center; gap: 6px;
          transition: color .15s;
        }
        .back-link:hover { color: #fff; }
        .back-link svg { width: 14px; height: 14px; }
        .header-divider { color: #374151; }
        .logo {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1.4rem; letter-spacing: .08em; color: var(--accent);
        }
        .logo span { color: #fff; }

        .hero {
          background: var(--ink); padding: 56px 32px 72px; text-align: center;
          position: relative; overflow: hidden;
        }
        .hero::before {
          content: ''; position: absolute; inset: 0; pointer-events: none;
          background: radial-gradient(ellipse 60% 50% at 50% 100%, rgba(232,255,71,.07), transparent);
        }
        .hero-emoji { font-size: 3rem; margin-bottom: 12px; }
        .hero h1 {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(2.2rem, 6vw, 4rem); letter-spacing: .04em;
          color: #fff; margin-bottom: 8px;
        }
        .hero h1 em { font-style: normal; color: var(--accent); }
        .hero-sub { color: #9ca3af; font-size: .95rem; margin-bottom: 36px; }

        .search-wrap { max-width: 640px; margin: 0 auto; position: relative; z-index: 1; }
        .search-row {
          display: flex; background: #fff; border-radius: 50px;
          overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.4);
        }
        .search-input {
          flex: 1; padding: 17px 24px; font-size: 1rem;
          font-family: 'DM Sans', sans-serif; border: none; outline: none;
          background: transparent; color: var(--ink);
        }
        .search-btn {
          background: var(--accent); border: none; padding: 0 26px; cursor: pointer;
          font-family: 'DM Sans', sans-serif; font-weight: 600; font-size: .9rem;
          color: var(--ink); transition: background .2s;
          display: flex; align-items: center; gap: 8px;
        }
        .search-btn:hover { background: #f0ff70; }
        .search-btn svg { width: 17px; height: 17px; }

        .suggestions {
          display: flex; flex-wrap: wrap; gap: 8px;
          justify-content: center; margin-top: 18px;
        }
        .sug-btn {
          background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.15);
          border-radius: 50px; padding: 6px 14px; font-size: .8rem;
          color: #d1d5db; cursor: pointer; transition: all .18s;
          font-family: 'DM Sans', sans-serif;
        }
        .sug-btn:hover { background: var(--accent); border-color: var(--accent); color: var(--ink); }

        .results-section { max-width: 1160px; margin: 0 auto; padding: 44px 24px 80px; }
        .results-header {
          font-size: .8rem; font-weight: 600; letter-spacing: .1em;
          text-transform: uppercase; color: var(--mid);
          margin-bottom: 24px; padding-bottom: 14px; border-bottom: 2px solid var(--line);
        }
        .results-header strong { color: var(--ink); }
        .results-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 20px; }

        .result-card {
          background: #fff; border-radius: var(--radius); overflow: hidden;
          text-decoration: none; color: inherit; border: 1px solid var(--line);
          transition: transform .2s, box-shadow .2s;
          animation: fadeUp .3s both ease-out;
        }
        .result-card:hover { transform: translateY(-5px); box-shadow: 0 14px 36px rgba(0,0,0,.1); }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

        .card-thumb { position: relative; aspect-ratio: 16/9; background: #e5e7eb; overflow: hidden; }
        .card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .3s; }
        .result-card:hover .card-thumb img { transform: scale(1.04); }

        .timestamp-badge {
          position: absolute; bottom: 8px; right: 8px;
          background: rgba(0,0,0,.75); color: #fff;
          font-size: .68rem; font-weight: 600; padding: 2px 6px; border-radius: 4px;
        }
        .play-overlay {
          position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,.3); color: #fff; opacity: 0; transition: opacity .2s;
        }
        .result-card:hover .play-overlay { opacity: 1; }

        .card-body { padding: 15px; }
        .card-channel {
          font-size: .68rem; font-weight: 600; letter-spacing: .1em;
          text-transform: uppercase; color: #059669; margin-bottom: 5px;
        }
        .card-title {
          font-family: 'DM Sans', sans-serif; font-weight: 600; font-size: 1rem;
          line-height: 1.3; margin-bottom: 8px;
          display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        }
        .card-excerpt {
          font-size: .8rem; color: var(--mid); line-height: 1.55;
          display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
          margin-bottom: 12px;
        }

        .relevance-badge { display: flex; align-items: center; gap: 10px; padding-top: 11px; border-top: 1px solid var(--line); }
        .relevance-dots { display: flex; gap: 4px; flex-shrink: 0; }
        .relevance-dot { width: 7px; height: 7px; border-radius: 50%; transition: background .3s; }
        .relevance-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .relevance-label { font-weight: 700; font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; }
        .relevance-sub { font-size: .7rem; color: var(--mid); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        .state-box { text-align: center; padding: 60px 24px; color: var(--mid); }
        .state-icon { font-size: 3rem; margin-bottom: 14px; }
        .state-box h2 { font-family: 'Bebas Neue', sans-serif; font-size: 1.6rem; letter-spacing: .06em; color: var(--ink); margin-bottom: 8px; }
        .spinner {
          width: 38px; height: 38px; border: 3px solid var(--line);
          border-top-color: var(--accent); border-radius: 50%;
          animation: spin .7s linear infinite; margin: 0 auto 14px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .footer { background: var(--ink); color: #4b5563; text-align: center; padding: 24px; font-size: .75rem; letter-spacing: .1em; text-transform: uppercase; }

        @media (max-width: 600px) {
          .hero { padding: 44px 16px 60px; }
          .results-grid { grid-template-columns: 1fr; }
          .search-btn span { display: none; }
        }
      `}</style>

      <header className="header">
        <Link href="/" className="back-link">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
          Tous les sports
        </Link>
        <span className="header-divider">/</span>
        <div className="logo">Tuto<span>Vid</span></div>
      </header>

      <section className="hero">
        {sport && <div className="hero-emoji">{sport.emoji}</div>}
        <h1>
          {sport ? <><em>{sport.name}</em> — trouve ton tuto</> : "Chargement…"}
        </h1>
        <p className="hero-sub">{sport?.description}</p>

        <div className="search-wrap">
          <div className="search-row">
            <input
              ref={inputRef}
              className="search-input"
              type="text"
              placeholder="Décris ce que tu veux apprendre…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKey}
              autoFocus
            />
            <button className="search-btn" onClick={() => search(query)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
              <span>Chercher</span>
            </button>
          </div>

          {sport?.suggestions && (
            <div className="suggestions">
              {sport.suggestions.map((s: string) => (
                <button key={s} className="sug-btn"
                  onClick={() => { setQuery(s); search(s); }}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <main className="results-section">
        {loading && <div className="state-box"><div className="spinner" /><p>Recherche en cours…</p></div>}

        {!loading && error && (
          <div className="state-box">
            <div className="state-icon">⚠️</div>
            <h2>Erreur</h2><p>{error}</p>
          </div>
        )}

        {!loading && !error && searched && results.length === 0 && (
          <div className="state-box">
            <div className="state-icon">{sport?.emoji || "🎯"}</div>
            <h2>Aucun résultat</h2>
            <p>Essaie d&apos;autres mots-clés ou une formulation différente.</p>
          </div>
        )}

        {!loading && results.length > 0 && (
          <>
            <p className="results-header">
              <strong>{results.length} vidéos</strong> pour «&nbsp;{query}&nbsp;»
            </p>
            <div className="results-grid">
              {results.map((r, i) => <ResultCard key={r.videoId} r={r} index={i} />)}
            </div>
          </>
        )}

        {!searched && !loading && (
          <div className="state-box">
            <div className="state-icon">{sport?.emoji || "🎯"}</div>
            <h2>Prêt à apprendre</h2>
            <p>Lance ta recherche pour trouver les meilleurs tutoriels.</p>
          </div>
        )}
      </main>

      <footer className="footer">TutoVid — moteur sémantique • Données YouTube</footer>
    </>
  );
}
