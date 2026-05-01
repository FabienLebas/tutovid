// app/api/search/route.ts
// Recherche hybride : sémantique (embeddings) + fallback texte pour les termes techniques

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type ChunkRow = {
  video_id: string; title: string; thumbnail: string;
  channel: string; sport_slug: string; start_sec: number;
  text: string; similarity: number;
};

// Signaux pédagogiques détectés dans le titre de la vidéo.
// Multiplicateur appliqué au score final : ×(1 + boost).
const EDU_STRONG = [
  // Français
  "tuto", "tutoriel",
  "comment ", "j'apprends", "je t'apprends", "je vous apprends",
  "apprendre", "apprenez",
  "cours ", "leçon", "formation",
  "exercice", "débutant", "progresser", "améliorer", "travailler son",
  // Anglais
  "tutorial", "how to", "how-to", "learn", "beginner", "lesson",
  "drill", "improve your", "step by step",
  // Espagnol
  "tutorial", "cómo ", "como ", "aprende", "aprender", "aprendiendo",
  "clase ", "lección", "ejercicio", "principiante", "mejorar",
];
const EDU_MODERATE = [
  // Français
  "technique", "conseils", "astuces", "guide",
  "comprendre", "analyse", "explication", "secret",
  "erreur à éviter", "correction", "pourquoi",
  // Anglais
  "tips", "tricks", "technique", "guide", "understand",
  "analysis", "explanation", "mistake", "fix your", "fix your",
  // Espagnol
  "técnica", "consejos", "trucos", "guía", "análisis",
  "explicación", "secreto", "error", "corregir",
];
const EDU_ANTI = [
  // Toutes langues
  "highlights", "best of", "vlog", "podcast", "interview",
  "live match", "match complet", "tournoi", "finale ",
  // Espagnol
  "highlights", "resumen", "en directo", "torneo", "final ",
];

function educationalMultiplier(title: string): number {
  const t = title.toLowerCase();
  if (EDU_ANTI.some(kw => t.includes(kw)))     return 0.90; // −10 %
  if (EDU_STRONG.some(kw => t.includes(kw)))   return 1.20; // +20 %
  if (EDU_MODERATE.some(kw => t.includes(kw))) return 1.10; // +10 %
  return 1.00;
}

function aggregateByVideo(rows: ChunkRow[], limit: number) {
  const byVideo = new Map<string, { meta: ChunkRow; scores: number[] }>();
  for (const r of rows) {
    if (!byVideo.has(r.video_id)) byVideo.set(r.video_id, { meta: r, scores: [] });
    byVideo.get(r.video_id)!.scores.push(r.similarity);
  }
  return Array.from(byVideo.values())
    .map(({ meta, scores }) => {
      const best = Math.max(...scores);
      const avg  = scores.reduce((a, b) => a + b, 0) / scores.length;
      const base = best * 0.6 + avg * 0.4;
      return { meta, aggregated: base * educationalMultiplier(meta.title), chunkCount: scores.length };
    })
    .sort((a, b) => b.aggregated - a.aggregated)
    .slice(0, limit)
    .map(({ meta, aggregated, chunkCount }) => ({
      videoId:    meta.video_id,
      title:      meta.title,
      thumbnail:  meta.thumbnail,
      channel:    meta.channel,
      sport:      meta.sport_slug,
      startSec:   meta.start_sec,
      excerpt:    meta.text,
      similarity: Math.round(aggregated * 100),
      chunkCount,
      youtubeUrl: `https://www.youtube.com/watch?v=${meta.video_id}${
        meta.start_sec ? `&t=${meta.start_sec}s` : ""
      }`,
    }));
}

// Recherche par correspondance exacte du texte dans les chunks.
// Complémentaire à la recherche sémantique : couvre les cas où l'embedding
// ne ramène pas le bon chunk (termes techniques, citations exactes, noms propres).
async function textSearch(
  query: string, sportSlug: string | null, limit: number
): Promise<ChunkRow[]> {
  let q = supabase
    .from("chunks")
    .select("video_id, start_sec, text, sport_slug, videos(title, thumbnail_url, channels(name))")
    .ilike("text", `%${query}%`)
    .limit(limit * 8);

  if (sportSlug) q = q.eq("sport_slug", sportSlug);

  const { data, error } = await q;
  if (error || !data) return [];

  return (data as any[]).map((c) => ({
    video_id:   c.video_id,
    title:      c.videos?.title ?? "",
    thumbnail:  c.videos?.thumbnail_url ?? "",
    channel:    c.videos?.channels?.name ?? "",
    sport_slug: c.sport_slug,
    start_sec:  c.start_sec,
    text:       c.text,
    similarity: 0.55, // score de base pour un match textuel exact
  }));
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query      = searchParams.get("q")?.trim();
  const sportSlug  = searchParams.get("sport") || null;
  const limit      = Math.min(parseInt(searchParams.get("limit") || "10"), 60);
  const threshold  = parseFloat(searchParams.get("threshold") || "0.3");

  if (!query || query.length < 2) {
    return NextResponse.json({ error: "Requête trop courte" }, { status: 400 });
  }

  try {
    // 1. Enrichir la requête avec le contexte sport avant d'embedder.
    //    Évite que les termes techniques courts (ex: "vibora", "smash") soient
    //    interprétés hors contexte sportif par le modèle d'embedding.
    const embInput = sportSlug ? `${query} ${sportSlug}` : query;
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: embInput,
    });
    const queryEmbedding = embResp.data[0].embedding;

    // 2. Recherche sémantique + recherche texte exacte en parallèle
    const [semanticResult, textRows] = await Promise.all([
      supabase.rpc("search_chunks", {
        query_embedding: queryEmbedding,
        p_sport_slug:    sportSlug,
        match_threshold: threshold,
        match_count:     limit * 8,
      }),
      textSearch(query, sportSlug, limit),
    ]);

    if (semanticResult.error) throw semanticResult.error;

    const semanticRows = (semanticResult.data || []) as ChunkRow[];

    // Fusion sémantique + texte avec gestion de la priorité des matches exacts
    const textMatchKeys = new Set(textRows.map(r => `${r.video_id}:${r.start_sec}`));
    const hasTextMatches = textRows.length > 0;

    const boostedSemantic = semanticRows.map(r => {
      if (textMatchKeys.has(`${r.video_id}:${r.start_sec}`)) {
        // Chunk trouvé dans les deux : boost fort
        return { ...r, similarity: Math.min(1, r.similarity + 0.25) };
      }
      if (hasTextMatches) {
        // Des matches texte exacts existent mais pas ce chunk : pénalité
        // Évite qu'une vidéo avec les mots dans le mauvais ordre batte la bonne
        return { ...r, similarity: r.similarity * 0.80 };
      }
      return r;
    });

    // Chunks texte non trouvés par la recherche sémantique
    // Score 0.70 (au lieu de 0.55) pour battre les résultats sémantiques pénalisés
    const semanticKeys = new Set(semanticRows.map(r => `${r.video_id}:${r.start_sec}`));
    const textOnly = textRows
      .filter(r => !semanticKeys.has(`${r.video_id}:${r.start_sec}`))
      .map(r => ({ ...r, similarity: 0.70 }));

    const rows = [...boostedSemantic, ...textOnly];

    const results = aggregateByVideo(rows, limit);
    return NextResponse.json({ results, query, sport: sportSlug });
  } catch (err: any) {
    console.error("Search error:", err);
    return NextResponse.json({ error: err.message || "Erreur serveur" }, { status: 500 });
  }
}
