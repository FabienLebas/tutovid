// app/api/sport/[slug]/route.ts
// Retourne les infos d'un sport (nom, emoji, suggestions…)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(_req: NextRequest, { params }: { params: { slug: string } }) {
  const { data, error } = await supabase
    .from("sports")
    .select("slug, name, emoji, description, suggestions")
    .eq("slug", params.slug)
    .eq("active", true)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Sport introuvable" }, { status: 404 });
  }

  return NextResponse.json({ sport: data });
}
