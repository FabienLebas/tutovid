-- ============================================================
-- SCHEMA SUPABASE - TutoVid (Multi-Sport Video Search)
-- À exécuter une seule fois dans l'éditeur SQL de Supabase
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── TABLE : sports / domaines ──────────────────────────────────
-- Chaque sport est une entrée indépendante avec son slug URL,
-- son nom affiché, et ses suggestions de recherche.
CREATE TABLE IF NOT EXISTS sports (
  slug         TEXT PRIMARY KEY,        -- 'golf', 'padel', 'chess'…
  name         TEXT NOT NULL,           -- 'Golf', 'Padel', 'Échecs'
  emoji        TEXT,                    -- '⛳', '🎾', '♟️'
  description  TEXT,                   -- phrase d'accroche pour la page
  suggestions  TEXT[],                 -- suggestions affichées sur la page de recherche
  active       BOOLEAN DEFAULT TRUE,   -- pour masquer un sport sans le supprimer
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Sports de départ
INSERT INTO sports (slug, name, emoji, description, suggestions) VALUES
  ('golf',  'Golf',   '⛳', 'Corrige tes défauts de swing, améliore ton short game et baisse ton handicap.',
   ARRAY['corriger mon slice', 'chip autour du green', 'putting longue distance', 'sortie de bunker', 'driver plus loin', 'wedge 50 mètres']),
  ('padel', 'Padel',  '🎾', 'Maîtrise les coups techniques, les placements et la tactique du padel.',
   ARRAY['smash défensif', 'vibora technique', 'position au filet', 'revers lifté', 'déplacement latéral', 'service padel']),
  ('chess', 'Échecs', '♟️', 'Progressez en ouvertures, en milieu de jeu et en finales.',
   ARRAY['défense sicilienne', 'attaque du roi en finale', 'gambit dame', 'partie espagnole', 'finale tours', 'stratégie centre'])
ON CONFLICT (slug) DO NOTHING;

-- ── TABLE : chaînes indexées ────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,         -- YouTube channel ID (UCxxxxxx)
  sport_slug   TEXT REFERENCES sports(slug) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  url          TEXT NOT NULL,
  indexed_at   TIMESTAMPTZ DEFAULT NOW(),
  video_count  INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS channels_sport_idx ON channels(sport_slug);

-- ── TABLE : vidéos ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS videos (
  id                TEXT PRIMARY KEY,    -- YouTube video ID
  channel_id        TEXT REFERENCES channels(id) ON DELETE CASCADE,
  sport_slug        TEXT REFERENCES sports(slug) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  published_at      TIMESTAMPTZ,
  duration_seconds  INTEGER,
  thumbnail_url     TEXT,
  language          TEXT,               -- 'fr', 'en', 'unknown'
  transcript_source TEXT,              -- 'youtube_auto', 'youtube_manual', 'whisper', 'none'
  index_status      TEXT DEFAULT 'pending', -- 'pending','indexing','indexed','no_transcript','failed'
  indexed_at        TIMESTAMPTZ DEFAULT NOW()
);

-- sport_slug est dénormalisé ici pour éviter une jointure supplémentaire
-- dans la recherche vectorielle (perf critique)
CREATE INDEX IF NOT EXISTS videos_sport_idx      ON videos(sport_slug);
CREATE INDEX IF NOT EXISTS videos_channel_idx    ON videos(channel_id);
CREATE INDEX IF NOT EXISTS videos_published_idx  ON videos(published_at DESC);

-- ── TABLE : chunks de transcription ────────────────────────────
CREATE TABLE IF NOT EXISTS chunks (
  id           BIGSERIAL PRIMARY KEY,
  video_id     TEXT REFERENCES videos(id) ON DELETE CASCADE,
  sport_slug   TEXT REFERENCES sports(slug) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  start_sec    INTEGER,
  end_sec      INTEGER,
  text         TEXT NOT NULL,
  embedding    vector(1536),            -- OpenAI text-embedding-3-small
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Index vectoriel HNSW (recherche rapide par similarité)
CREATE INDEX IF NOT EXISTS chunks_embedding_idx
  ON chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- sport_slug indexé pour filtrer rapidement par sport
CREATE INDEX IF NOT EXISTS chunks_sport_idx   ON chunks(sport_slug);
CREATE INDEX IF NOT EXISTS chunks_video_idx   ON chunks(video_id);

-- Supabase active RLS par défaut sur certains projets — on le désactive
-- explicitement car l'accès est contrôlé par les clés API (anon vs service_role)
ALTER TABLE sports   DISABLE ROW LEVEL SECURITY;
ALTER TABLE channels DISABLE ROW LEVEL SECURITY;
ALTER TABLE videos   DISABLE ROW LEVEL SECURITY;
ALTER TABLE chunks   DISABLE ROW LEVEL SECURITY;

-- ── FONCTION : recherche sémantique filtrée par sport ───────────
-- Le paramètre p_sport_slug permet de restreindre la recherche
-- à un seul sport. Si NULL → recherche globale (tous sports).
CREATE OR REPLACE FUNCTION search_chunks(
  query_embedding  vector(1536),
  p_sport_slug     TEXT    DEFAULT NULL,
  match_threshold  FLOAT   DEFAULT 0.45,
  match_count      INT     DEFAULT 80
)
RETURNS TABLE (
  chunk_id    BIGINT,
  video_id    TEXT,
  title       TEXT,
  thumbnail   TEXT,
  channel     TEXT,
  sport_slug  TEXT,
  start_sec   INTEGER,
  text        TEXT,
  similarity  FLOAT
)
LANGUAGE sql STABLE
AS $$
  SELECT
    c.id                                      AS chunk_id,
    v.id                                      AS video_id,
    v.title,
    v.thumbnail_url                           AS thumbnail,
    ch.name                                   AS channel,
    c.sport_slug,
    c.start_sec,
    c.text,
    1 - (c.embedding <=> query_embedding)     AS similarity
  FROM chunks c
  JOIN videos   v  ON v.id  = c.video_id
  JOIN channels ch ON ch.id = v.channel_id
  WHERE
    (p_sport_slug IS NULL OR c.sport_slug = p_sport_slug)
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── VUE : stats d'indexation par sport ─────────────────────────
CREATE OR REPLACE VIEW indexing_stats AS
SELECT
  s.slug                                              AS sport,
  s.name                                              AS sport_name,
  ch.name                                             AS channel,
  COUNT(DISTINCT v.id)                                AS videos,
  COUNT(c.id)                                         AS chunks,
  SUM(CASE WHEN v.transcript_source = 'none' THEN 1 ELSE 0 END) AS no_transcript,
  MAX(v.indexed_at)                                   AS last_indexed
FROM sports s
LEFT JOIN channels ch ON ch.sport_slug = s.slug
LEFT JOIN videos   v  ON v.channel_id  = ch.id
LEFT JOIN chunks   c  ON c.video_id    = v.id
GROUP BY s.slug, s.name, ch.name
ORDER BY s.slug, ch.name;
