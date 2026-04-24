import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TutoVid – Trouve tes tutoriels vidéo",
  description: "Moteur de recherche sémantique dans les transcriptions de tutoriels vidéo : sport, golf, padel et plus.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
