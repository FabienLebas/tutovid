#!/bin/bash
# index_overnight.sh — Indexation en boucle jusqu'à épuisement
#
# Usage :
#   ./index_overnight.sh                        # tous les sports, batch 200, pause 5min
#   ./index_overnight.sh --sport padel          # un sport uniquement
#   ./index_overnight.sh --batch 100 --pause 3  # batch 100 vidéos, pause 3min entre chaque
#
# Ctrl+C arrête proprement à la fin du batch en cours.

set -euo pipefail

# ── Paramètres par défaut ────────────────────────────────────────────────────
SPORT_ARG=""
BATCH=200
PAUSE_MIN=15

# ── Parsing des arguments ────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sport)   SPORT_ARG="--sport $2"; shift 2 ;;
        --batch)   BATCH="$2";             shift 2 ;;
        --pause)   PAUSE_MIN="$2";         shift 2 ;;
        *) echo "Option inconnue : $1"; exit 1 ;;
    esac
done

PAUSE_SEC=$((PAUSE_MIN * 60))
INDEX_ARG="${SPORT_ARG:---all}"

# ── Chemin du projet ─────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
source venv/bin/activate

# macOS limite à 256 fichiers ouverts par défaut — insuffisant pour Whisper + yt-dlp + Deno sur une longue session
ulimit -n 4096

# ── Gestion de Ctrl+C ────────────────────────────────────────────────────────
STOPPING=0
trap 'STOPPING=1; echo ""; echo "⏹  Arrêt demandé — fin du batch en cours, puis stop."' INT

# ── Boucle principale ────────────────────────────────────────────────────────
round=0
start_time=$(date +%s)

echo ""
echo "🌙 Indexation nocturne démarrée — $(date '+%d/%m/%Y %H:%M:%S')"
echo "   Cible     : ${SPORT_ARG:-tous les sports}"
echo "   Batch     : $BATCH vidéos par round"
echo "   Pause     : ${PAUSE_MIN}min entre les rounds"
echo "   Ctrl+C    : arrêt propre après le batch en cours"
echo ""

while true; do
    round=$((round + 1))
    elapsed=$(( $(date +%s) - start_time ))
    h=$((elapsed / 3600)); m=$(( (elapsed % 3600) / 60 ))
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Round $round — $(date '+%H:%M:%S') — +${h}h${m}m depuis le départ"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    # Lance un batch ; code 2 = rien à faire, tout est indexé
    python indexer.py index $INDEX_ARG --batch "$BATCH" --no-sleep
    exit_code=$?

    if [[ $exit_code -eq 2 ]]; then
        echo ""
        echo "🎉 Tout est indexé ! Rien de plus à faire."
        break
    fi

    if [[ $STOPPING -eq 1 ]]; then
        echo ""
        echo "⏹  Arrêt propre — reprends avec la même commande pour continuer."
        break
    fi

    echo ""
    echo "😴 Pause de ${PAUSE_MIN}min (évite le rate-limiting YouTube)…"
    echo "   Prochain round à $(date -v +${PAUSE_SEC}S '+%H:%M:%S' 2>/dev/null \
         || date -d "+${PAUSE_SEC} seconds" '+%H:%M:%S' 2>/dev/null \
         || echo '?')"
    echo ""

    # Pause interruptible par Ctrl+C
    sleep "$PAUSE_SEC" &
    wait $! 2>/dev/null || true

    if [[ $STOPPING -eq 1 ]]; then
        echo "⏹  Arrêt propre — reprends avec la même commande pour continuer."
        break
    fi
done

total_elapsed=$(( $(date +%s) - start_time ))
th=$((total_elapsed / 3600)); tm=$(( (total_elapsed % 3600) / 60 ))
echo ""
echo "✅ Session terminée en ${th}h${tm}m — $(date '+%d/%m/%Y %H:%M:%S')"
