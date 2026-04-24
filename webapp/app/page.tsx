/* app/page.tsx – Portail d'accueil multi-sport */
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

async function getSports() {
  const { data } = await supabase
    .from("sports")
    .select("slug, name, emoji, description, suggestions")
    .eq("active", true)
    .order("slug");
  return data || [];
}

export const revalidate = 3600; // revalidation ISR toutes les heures

export default async function Home() {
  const sports = await getSports();

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --ink:    #0a0a0a;
          --paper:  #f7f6f2;
          --accent: #e8ff47;
          --mid:    #6b7280;
          --line:   #e5e4df;
          --radius: 16px;
        }
        body { font-family: 'DM Sans', sans-serif; background: var(--paper); color: var(--ink); }

        .header {
          background: var(--ink);
          padding: 20px 40px;
          display: flex; align-items: center;
        }
        .logo {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1.8rem; letter-spacing: .08em;
          color: var(--accent);
        }
        .logo span { color: #fff; margin-left: 2px; }

        .hero {
          background: var(--ink);
          padding: 80px 40px 100px;
          text-align: center;
        }
        .hero-tag {
          display: inline-block;
          background: rgba(232,255,71,.12);
          border: 1px solid rgba(232,255,71,.3);
          color: var(--accent);
          font-size: .7rem; font-weight: 600;
          letter-spacing: .18em; text-transform: uppercase;
          padding: 6px 16px; border-radius: 50px;
          margin-bottom: 24px;
        }
        .hero h1 {
          font-family: 'Bebas Neue', sans-serif;
          font-size: clamp(3rem, 8vw, 6rem);
          letter-spacing: .04em; line-height: 1;
          color: #fff; margin-bottom: 16px;
        }
        .hero h1 em { font-style: normal; color: var(--accent); }
        .hero p {
          color: #9ca3af; font-size: 1.05rem;
          max-width: 480px; margin: 0 auto;
        }

        /* ── Grille des sports ── */
        .sports-section {
          max-width: 1100px;
          margin: -40px auto 80px;
          padding: 0 24px;
        }
        .sports-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 20px;
        }
        .sport-card {
          background: #fff;
          border: 1px solid var(--line);
          border-radius: var(--radius);
          padding: 32px 28px;
          text-decoration: none; color: inherit;
          transition: transform .2s, box-shadow .2s, border-color .2s;
          display: flex; flex-direction: column; gap: 16px;
        }
        .sport-card:hover {
          transform: translateY(-6px);
          box-shadow: 0 16px 40px rgba(0,0,0,.1);
          border-color: var(--accent);
        }
        .sport-emoji { font-size: 2.5rem; }
        .sport-name {
          font-family: 'Bebas Neue', sans-serif;
          font-size: 1.8rem; letter-spacing: .06em;
        }
        .sport-desc {
          font-size: .88rem; color: var(--mid); line-height: 1.55;
          flex: 1;
        }
        .sport-cta {
          display: flex; align-items: center; gap: 8px;
          font-size: .8rem; font-weight: 600;
          letter-spacing: .08em; text-transform: uppercase;
          color: var(--ink);
        }
        .sport-cta svg { width: 16px; height: 16px; }
        .sport-card:hover .sport-cta { color: #000; }

        .footer {
          background: var(--ink); color: #4b5563;
          text-align: center; padding: 28px;
          font-size: .75rem; letter-spacing: .1em; text-transform: uppercase;
          font-family: 'DM Sans', sans-serif;
        }
      `}</style>

      <header className="header">
        <div className="logo">Tuto<span>Vid</span></div>
      </header>

      <section className="hero">
        <div className="hero-tag">Moteur de recherche vidéo</div>
        <h1>Trouve le tuto<br /><em>qu&apos;il te faut</em></h1>
        <p>Recherche dans les transcriptions complètes de milliers de vidéos YouTube, par sport.</p>
      </section>

      <main className="sports-section">
        <div className="sports-grid">
          {sports.map((s: any) => (
            <Link key={s.slug} href={`/sport/${s.slug}`} className="sport-card">
              <div className="sport-emoji">{s.emoji}</div>
              <div className="sport-name">{s.name}</div>
              <p className="sport-desc">{s.description}</p>
              <div className="sport-cta">
                Rechercher
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      </main>

      <footer className="footer">
        TutoVid — moteur sémantique • Données YouTube
      </footer>
    </>
  );
}
