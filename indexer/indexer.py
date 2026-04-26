"""
TutoVid – Multi-Sport Video Indexer
────────────────────────────────────
Pipeline local d'indexation de chaînes YouTube → Supabase.
Résistant aux interruptions : reprend là où il s'est arrêté.

Usage:
  python indexer.py list-sports
  python indexer.py add-channel  UCxxxxxx --sport golf
  python indexer.py index --sport golf              # tout indexer
  python indexer.py index --sport golf --batch 50   # 50 vidéos et stop
  python indexer.py index --sport golf --no-sleep   # empêche la veille
  python indexer.py index --all --batch 100 --no-sleep
  python indexer.py stats
"""

import os
import sys
import time
import platform
import subprocess
import signal
import click
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

from googleapiclient.discovery import build
from youtube_transcript_api import YouTubeTranscriptApi, NoTranscriptFound, TranscriptsDisabled
from openai import OpenAI
from supabase import create_client, Client
from tqdm import tqdm

load_dotenv()

# ── Clients ─────────────────────────────────────────────────────────────────

def get_youtube():
    return build("youtube", "v3", developerKey=os.environ["YOUTUBE_API_KEY"])

def get_openai():
    return OpenAI(api_key=os.environ["OPENAI_API_KEY"])

def get_supabase() -> Client:
    return create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

# ── Gestion de la veille ────────────────────────────────────────────────────

class SleepBlocker:
    """
    Empêche la mise en veille pendant l'indexation.
    - Mac  : lance `caffeinate -i` en arrière-plan
    - Linux: lance `systemd-inhibit` si disponible
    - Windows : appelle SetThreadExecutionState via ctypes
    Utilisé comme context manager : with SleepBlocker(): ...
    """

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._proc = None

    def __enter__(self):
        if not self.enabled:
            return self
        system = platform.system()
        try:
            if system == "Darwin":
                # caffeinate -i = empêche la veille système (idle sleep)
                self._proc = subprocess.Popen(["caffeinate", "-i"],
                                              stdout=subprocess.DEVNULL,
                                              stderr=subprocess.DEVNULL)
                click.echo("✅ Veille désactivée (caffeinate actif)")

            elif system == "Linux":
                # systemd-inhibit disponible sur la plupart des distros modernes
                self._proc = subprocess.Popen(
                    ["systemd-inhibit", "--what=sleep:idle",
                     "--who=TutoVid Indexer", "--why=Indexation en cours",
                     "--mode=block", "sleep", "infinity"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
                )
                click.echo("✅ Veille désactivée (systemd-inhibit actif)")

            elif system == "Windows":
                import ctypes
                # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040)
                click.echo("✅ Veille désactivée (Windows SetThreadExecutionState)")

        except FileNotFoundError:
            click.echo("⚠️  --no-sleep : commande système non disponible, veille non bloquée.")
        return self

    def __exit__(self, *_):
        if not self.enabled:
            return
        system = platform.system()
        if self._proc:
            self._proc.terminate()
            self._proc.wait()
            click.echo("😴 Veille réactivée.")
        elif system == "Windows":
            try:
                import ctypes
                ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)
            except Exception:
                pass

# ── YouTube ─────────────────────────────────────────────────────────────────

def fetch_channel_info(yt, channel_id: str) -> dict:
    resp = yt.channels().list(part="snippet", id=channel_id).execute()
    if not resp.get("items"):
        raise ValueError(f"Chaîne introuvable : {channel_id}")
    s = resp["items"][0]["snippet"]
    return {"id": channel_id, "name": s["title"],
            "url": f"https://www.youtube.com/channel/{channel_id}"}

def fetch_all_video_ids(yt, channel_id: str) -> list[str]:
    video_ids, page_token = [], None
    ch = yt.channels().list(part="contentDetails", id=channel_id).execute()
    uploads_id = ch["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    while True:
        kwargs = dict(part="contentDetails", playlistId=uploads_id, maxResults=50)
        if page_token:
            kwargs["pageToken"] = page_token
        resp = yt.playlistItems().list(**kwargs).execute()
        for item in resp.get("items", []):
            video_ids.append(item["contentDetails"]["videoId"])
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return video_ids

def fetch_video_details(yt, video_ids: list[str]) -> list[dict]:
    results = []
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i:i+50]
        resp = yt.videos().list(part="snippet,contentDetails", id=",".join(batch)).execute()
        for item in resp.get("items", []):
            s = item["snippet"]
            results.append({
                "id": item["id"],
                "title": s["title"],
                "description": s.get("description", ""),
                "published_at": s["publishedAt"],
                "thumbnail_url": (s["thumbnails"].get("high") or
                                  s["thumbnails"].get("default", {})).get("url"),
                "duration_seconds": parse_iso_duration(item["contentDetails"]["duration"]),
            })
    return results

def parse_iso_duration(duration: str) -> int:
    import re
    m = re.match(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", duration)
    if not m:
        return 0
    h, mi, s = (int(x or 0) for x in m.groups())
    return h * 3600 + mi * 60 + s

# ── Transcription ────────────────────────────────────────────────────────────

class NoYouTubeTranscript(Exception):
    pass

def get_transcript(video_id: str, languages: list[str]) -> tuple[list[dict], str]:
    """Lève NoYouTubeTranscript si aucun sous-titre YouTube et Whisper désactivé.
    Les erreurs Whisper (ImportError, ffmpeg…) propagent librement → statut 'failed'."""
    try:
        transcript_list = YouTubeTranscriptApi.list_transcripts(video_id)
        for lang in languages:
            try:
                return transcript_list.find_manually_created_transcript([lang]).fetch(), "youtube_manual"
            except Exception:
                pass
        for lang in languages:
            try:
                return transcript_list.find_generated_transcript([lang]).fetch(), "youtube_auto"
            except Exception:
                pass
        for lang in languages:
            try:
                return transcript_list.find_transcript(
                    [t.language_code for t in transcript_list]
                ).translate(lang).fetch(), "youtube_auto"
            except Exception:
                pass
    except (NoTranscriptFound, TranscriptsDisabled):
        pass

    if os.getenv("USE_WHISPER_FALLBACK", "false").lower() == "true":
        model = os.getenv("WHISPER_MODEL", "small")
        click.echo(f"  🎙️  Whisper ({model}) — transcription locale de {video_id}…")
        return transcribe_with_whisper(video_id), "whisper"

    raise NoYouTubeTranscript(video_id)

def transcribe_with_whisper(video_id: str) -> list[dict]:
    import yt_dlp
    import whisper
    model_name = os.getenv("WHISPER_MODEL", "small")
    with tempfile.TemporaryDirectory() as tmp:
        audio_path = Path(tmp) / "audio.mp3"
        yt_dlp.YoutubeDL({
            "format": "bestaudio/best",
            "outtmpl": str(audio_path.with_suffix("")),
            "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3"}],
            "quiet": True,
        }).download([f"https://www.youtube.com/watch?v={video_id}"])
        model = whisper.load_model(model_name)
        result = model.transcribe(str(audio_path), verbose=False)
    return [{"text": seg["text"], "start": seg["start"], "duration": seg["end"] - seg["start"]}
            for seg in result["segments"]]

# ── Chunking ─────────────────────────────────────────────────────────────────

def segments_to_chunks(segments: list[dict], chunk_size=350, overlap=50) -> list[dict]:
    chunks, words_buffer, start_sec, current_end_sec = [], [], 0, 0
    for seg in segments:
        words = seg["text"].split()
        if not words_buffer:
            start_sec = int(seg.get("start", 0))
        words_buffer.extend(words)
        current_end_sec = int(seg.get("start", 0) + seg.get("duration", 0))
        if len(words_buffer) >= chunk_size:
            chunks.append({"text": " ".join(words_buffer[:chunk_size]),
                           "start_sec": start_sec, "end_sec": current_end_sec,
                           "chunk_index": len(chunks)})
            words_buffer = words_buffer[chunk_size - overlap:]
            start_sec = current_end_sec
    if words_buffer:
        chunks.append({"text": " ".join(words_buffer),
                       "start_sec": start_sec, "end_sec": current_end_sec,
                       "chunk_index": len(chunks)})
    return chunks

def make_title_chunk(video: dict) -> dict:
    text = f"{video['title']}\n\n{video.get('description', '')[:500]}"
    return {"text": text.strip(), "start_sec": 0, "end_sec": 0, "chunk_index": -1}

# ── Embeddings ───────────────────────────────────────────────────────────────

def embed_texts(openai_client: OpenAI, texts: list[str]) -> list[list[float]]:
    embeddings = []
    for i in range(0, len(texts), 100):
        batch = [t if t.strip() else "." for t in texts[i:i+100]]
        resp = openai_client.embeddings.create(model="text-embedding-3-small", input=batch)
        embeddings.extend([e.embedding for e in resp.data])
        time.sleep(0.1)
    return embeddings

# ── Supabase ─────────────────────────────────────────────────────────────────

# Statuts possibles d'une vidéo dans la colonne index_status :
#   pending      → repérée mais pas encore traitée
#   indexing     → traitement en cours (utile pour détecter les crashs)
#   indexed      → traitée avec succès
#   failed       → erreur répétée, à investiguer
#   no_transcript → pas de sous-titres disponibles

def upsert_video(sb: Client, channel_id: str, sport_slug: str,
                 video: dict, source: str, lang: str, status: str = "indexed"):
    sb.table("videos").upsert({
        "id": video["id"],
        "channel_id": channel_id,
        "sport_slug": sport_slug,
        "title": video["title"],
        "description": video.get("description"),
        "published_at": video.get("published_at"),
        "duration_seconds": video.get("duration_seconds"),
        "thumbnail_url": video.get("thumbnail_url"),
        "language": lang,
        "transcript_source": source,
        "index_status": status,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

def mark_video_indexing(sb: Client, channel_id: str, sport_slug: str, video: dict):
    """Marque la vidéo comme 'en cours' avant de la traiter.
    Si le script crashe brutalement, ces vidéos restent en état 'indexing'
    et seront reprises au prochain lancement."""
    sb.table("videos").upsert({
        "id": video["id"],
        "channel_id": channel_id,
        "sport_slug": sport_slug,
        "title": video["title"],
        "description": video.get("description"),
        "published_at": video.get("published_at"),
        "duration_seconds": video.get("duration_seconds"),
        "thumbnail_url": video.get("thumbnail_url"),
        "language": "unknown",
        "transcript_source": "pending",
        "index_status": "indexing",
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

def upsert_chunks(sb: Client, video_id: str, sport_slug: str,
                  chunks: list[dict], embeddings: list[list[float]]):
    sb.table("chunks").delete().eq("video_id", video_id).execute()
    rows = []
    for chunk, emb in zip(chunks, embeddings):
        rows.append({
            "video_id": video_id,
            "sport_slug": sport_slug,
            "chunk_index": chunk["chunk_index"],
            "start_sec": chunk["start_sec"],
            "end_sec": chunk["end_sec"],
            "text": chunk["text"],
            "embedding": emb,
        })
    for i in range(0, len(rows), 50):
        sb.table("chunks").insert(rows[i:i+50]).execute()

def get_videos_to_index(sb: Client, video_ids: list[str], force: bool) -> list[str]:
    """
    Retourne les IDs à traiter selon la logique de reprise :
    - Sans --force : exclut les vidéos 'indexed' et 'no_transcript'
      mais REPREND les 'indexing' (crash précédent) et 'failed'
    - Avec --force : retourne tout
    """
    if force:
        return video_ids

    existing = {
        r["id"]: r["index_status"]
        for r in sb.table("videos")
               .select("id, index_status")
               .in_("id", video_ids)
               .execute().data
    }

    to_skip    = {"indexed", "no_transcript"}
    to_process = []
    resumed    = 0

    for vid in video_ids:
        status = existing.get(vid)
        if status is None:
            to_process.append(vid)
        elif status not in to_skip:
            to_process.append(vid)
            resumed += 1

    if resumed:
        click.echo(f"  ⏩️  {resumed} vidéos interrompues ou en échec reprises")

    return to_process

# ── Pipeline vidéo (cœur du traitement) ─────────────────────────────────────

def process_video(sb, yt_client, openai_client, video, ch, sport_slug,
                  languages, chunk_size, chunk_overlap) -> str:
    """
    Traite une vidéo complète : transcription → chunks → embeddings → Supabase.
    Retourne le statut final : 'indexed', 'no_transcript', 'failed'
    """
    mark_video_indexing(sb, ch["id"], sport_slug, video)

    try:
        segments, source = get_transcript(video["id"], languages)
    except NoYouTubeTranscript:
        upsert_video(sb, ch["id"], sport_slug, video, "none", "unknown", "no_transcript")
        return "no_transcript"
    # Les erreurs Whisper (ImportError, ffmpeg, etc.) propagent → statut 'failed' + message visible

    try:
        all_chunks = [make_title_chunk(video)] + \
                     segments_to_chunks(segments, chunk_size, chunk_overlap)
        embeddings = embed_texts(openai_client, [c["text"] for c in all_chunks])
        upsert_video(sb, ch["id"], sport_slug, video, source, "unknown", "indexed")
        upsert_chunks(sb, video["id"], sport_slug, all_chunks, embeddings)
        return "indexed"
    except Exception as e:
        upsert_video(sb, ch["id"], sport_slug, video, "error", "unknown", "failed")
        raise e

# ── CLI ───────────────────────────────────────────────────────────────────────

@click.group()
def cli():
    """TutoVid Indexer — pipeline YouTube → Supabase"""
    pass

@cli.command("list-sports")
def list_sports():
    """Affiche les sports disponibles dans la base."""
    sb = get_supabase()
    rows = sb.table("sports").select("slug, name, emoji, active").execute().data
    click.echo("\n🎯 Sports configurés\n")
    for r in rows:
        status = "✅" if r["active"] else "⏸️"
        click.echo(f"  {status} {r['emoji']}  {r['slug']:<12} {r['name']}")
    click.echo()

@cli.command("add-channel")
@click.argument("channel_id")
@click.option("--sport", required=True, help="Slug du sport (ex: golf, padel, chess)")
def add_channel(channel_id: str, sport: str):
    """Enregistre une chaîne YouTube et la rattache à un sport."""
    yt = get_youtube()
    sb = get_supabase()
    sport_row = sb.table("sports").select("slug").eq("slug", sport).execute().data
    if not sport_row:
        click.echo(f"❌ Sport inconnu : '{sport}'. Lance 'list-sports' pour voir les options.")
        sys.exit(1)
    click.echo(f"🔍 Récupération infos chaîne {channel_id}...")
    info = fetch_channel_info(yt, channel_id)
    info["sport_slug"] = sport
    sb.table("channels").upsert(info).execute()
    click.echo(f"✅ Chaîne ajoutée : {info['name']} → sport : {sport}")

@cli.command("index")
@click.option("--sport",      default=None,  help="Indexe toutes les chaînes d'un sport")
@click.option("--channel",    default=None,  help="Indexe une chaîne spécifique (ID YouTube)")
@click.option("--all",  "index_all", is_flag=True, help="Indexe tous les sports")
@click.option("--batch",      default=0,     help="Traite N vidéos puis s'arrête proprement (0 = tout)")
@click.option("--force",      is_flag=True,  help="Réindexe même les vidéos déjà traitées")
@click.option("--no-sleep",   is_flag=True,  help="Empêche la mise en veille pendant l'indexation")
def index(sport: str, channel: str, index_all: bool,
          batch: int, force: bool, no_sleep: bool):
    """
    Lance le pipeline d'indexation.

    Reprise automatique : les vidéos interrompues (crash, Ctrl+C) ou
    en échec sont automatiquement reprises au prochain lancement,
    sans réindexer ce qui a déjà été traité avec succès.

    \b
    Exemples :
      python indexer.py index --sport golf
      python indexer.py index --sport golf --batch 50 --no-sleep
      python indexer.py index --all --batch 100 --no-sleep
    """
    yt            = get_youtube()
    sb            = get_supabase()
    openai_client = get_openai()

    languages     = os.getenv("TRANSCRIPT_LANGUAGES", "fr,en").split(",")
    chunk_size    = int(os.getenv("CHUNK_SIZE_WORDS",    350))
    chunk_overlap = int(os.getenv("CHUNK_OVERLAP_WORDS",  50))

    if index_all:
        channels = sb.table("channels").select("*").execute().data
    elif sport:
        channels = sb.table("channels").select("*").eq("sport_slug", sport).execute().data
    elif channel:
        row = sb.table("channels").select("*").eq("id", channel).execute().data
        channels = row if row else [{"id": channel, "name": channel, "sport_slug": "unknown"}]
    else:
        click.echo("❌ Spécifie --sport SLUG, --channel ID, ou --all")
        sys.exit(1)

    if not channels:
        click.echo("⚠️  Aucune chaîne trouvée. Lance d'abord : python indexer.py add-channel ...")
        sys.exit(0)

    if batch:
        click.echo(f"📦 Mode batch : traitement de {batch} vidéos maximum puis arrêt propre.")

    with SleepBlocker(enabled=no_sleep):

        total_done = 0

        for ch in channels:
            sport_slug = ch.get("sport_slug", "unknown")
            click.echo(f"\n📺 [{sport_slug.upper()}] {ch.get('name', ch['id'])}")

            click.echo("  → Récupération de la liste des vidéos...")
            all_video_ids = fetch_all_video_ids(yt, ch["id"])
            click.echo(f"  ✅ {len(all_video_ids)} vidéos sur la chaîne")

            video_ids = get_videos_to_index(sb, all_video_ids, force)
            click.echo(f"  ✅ {len(video_ids)} vidéos à traiter")

            if batch:
                remaining = batch - total_done
                if remaining <= 0:
                    click.echo("  ℹ️  Quota batch atteint, passage à la chaîne suivante ignoré.")
                    break
                video_ids = video_ids[:remaining]
                click.echo(f"  → Limité à {len(video_ids)} pour ce batch")

            if not video_ids:
                click.echo("  ✅ Rien à faire.")
                continue

            click.echo("  → Récupération des métadonnées...")
            videos = fetch_video_details(yt, video_ids)

            stats = {"indexed": 0, "no_transcript": 0, "failed": 0}

            for video in tqdm(videos, desc="  Indexation", unit="vidéo"):
                try:
                    result = process_video(
                        sb, yt, openai_client, video, ch, sport_slug,
                        languages, chunk_size, chunk_overlap
                    )
                    stats[result] = stats.get(result, 0) + 1
                except Exception as e:
                    tqdm.write(f"  ⚠️  [{video['id']}] {video['title'][:45]}: {e}")
                    stats["failed"] += 1

                total_done += 1

                if batch and total_done >= batch:
                    tqdm.write(f"\n  ℹ️  Batch de {batch} vidéos atteint — arrêt propre.")
                    break

            remaining_count = len(video_ids) - stats["indexed"] - stats["no_transcript"] - stats["failed"]
            click.echo(
                f"\n  📊 ✅ {stats['indexed']} indexées | "
                f"🔇 {stats['no_transcript']} sans transcript | "
                f"❌ {stats['failed']} erreurs"
                + (f" | ⏳ {remaining_count} restantes" if remaining_count > 0 else "")
            )

            sb.table("channels").update({"video_count": stats["indexed"]}).eq("id", ch["id"]).execute()

            if batch and total_done >= batch:
                click.echo(f"\n💡 Relance la même commande pour continuer l'indexation.")
                break

        click.echo(f"\n✅ Session terminée — {total_done} vidéos traitées au total.")

@cli.command("stats")
@click.option("--sport", default=None, help="Filtrer par sport")
def stats(sport: str):
    """Affiche les statistiques d'indexation."""
    sb = get_supabase()
    q = sb.table("indexing_stats").select("*")
    if sport:
        q = q.eq("sport", sport)
    rows = q.execute().data
    if not rows:
        click.echo("Aucune donnée.")
        return
    click.echo("\n📊 Statistiques d'indexation\n")
    current_sport = None
    for r in rows:
        if r["sport"] != current_sport:
            current_sport = r["sport"]
            click.echo(f"\n  🎯 {r['sport_name'].upper()}")
            click.echo(f"  {'Chaîne':<28} {'Vidéos':>7} {'Chunks':>8} {'Sans sub':>9} {'Dernière indexation'}")
            click.echo("  " + "─" * 72)
        click.echo(
            f"  {(r['channel'] or '—'):<28} {(r['videos'] or 0):>7} "
            f"{(r['chunks'] or 0):>8} {(r['no_transcript'] or 0):>9} "
            f"{str(r['last_indexed'] or '')[:19]}"
        )

if __name__ == "__main__":
    cli()
