// app/api/search/route.ts
// Recherche sémantique — filtrée par sport si ?sport=golf

import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query      = searchParams.get("q")?.trim();
  const sportSlug  = searchParams.get("sport") || null;
  const limit      = Math.min(parseInt(searchParams.get("limit") || "10"), 20);
  const threshold  = parseFloat(searchParams.get("threshold") || "0.3");

  if (!query || query.length < 2) {
    return NextResponse.json({ error: "Requête trop courte" }, { status: 400 });
  }

  try {
    // 1. Embedding de la requête
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });
    const queryEmbedding = embResp.data[0].embedding;

    // 2. Recherche vectorielle filtrée par sport
    const { data, error } = await supabase.rpc("search_chunks", {
      query_embedding: queryEmbedding,
      p_sport_slug:    sportSlug,          // NULL = tous sports
      match_threshold: threshold,
      match_count:     limit * 8,          // surcharge pour l'agrégation
    });

    if (error) throw error;

    // 3. Agrégation par vidéo — score combiné meilleur chunk + moyenne
    type ChunkRow = {
      video_id: string; title: string; thumbnail: string;
      channel: string; sport_slug: string; start_sec: number;
      text: string; similarity: number;
    };

    const byVideo = new Map<string, { meta: ChunkRow; scores: number[] }>();
    for (const r of (data || []) as ChunkRow[]) {
      if (!byVideo.has(r.video_id)) byVideo.set(r.video_id, { meta: r, scores: [] });
      byVideo.get(r.video_id)!.scores.push(r.similarity);
    }

    const results = Array.from(byVideo.values())
      .map(({ meta, scores }) => {
        const best = Math.max(...scores);
        const avg  = scores.reduce((a, b) => a + b, 0) / scores.length;
        return { meta, aggregated: best * 0.6 + avg * 0.4, chunkCount: scores.length };
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

    return NextResponse.json({ results, query, sport: sportSlug });
  } catch (err: any) {
    console.error("Search error:", err);
    return NextResponse.json({ error: err.message || "Erreur serveur" }, { status: 500 });
  }
}
