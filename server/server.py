"""
TLV Rentals — Training Data Server
====================================
Runs locally at http://localhost:8765

Collects human-labeled posts from the Chrome extension into a SQLite database
so they survive browser-data clears and are accessible for future model training.

Endpoints
---------
GET  /health        — liveness check
GET  /stats         — label counts + progress toward training threshold
POST /label         — save/update one post (called automatically by the extension)
POST /import-bulk   — bulk-import the dashboard JSON export (one-time backfill)
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "training.db"

app = FastAPI(title="TLV Rentals Training Server", version="1.0.0")

# Chrome extension pages have a chrome-extension:// origin.
# Allowing all origins is fine — the server only binds to localhost
# so it is not reachable from the public internet.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ── Database ──────────────────────────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS labeled_posts (
                post_id       TEXT PRIMARY KEY,
                text          TEXT NOT NULL,
                author_name   TEXT,
                group_name    TEXT,
                human_label   TEXT,
                price         REAL,
                rooms         REAL,
                size          REAL,
                entry_date    TEXT,
                roommates     INTEGER,
                broker        INTEGER,
                scraped_at    TEXT,
                synced_at     TEXT NOT NULL
            )
        """)
        conn.commit()
    print(f"[TLV Rentals] Database ready at {DB_PATH}")


@app.on_event("startup")
def startup():
    init_db()


# ── Request models ─────────────────────────────────────────────────────────────

class LabelPayload(BaseModel):
    post_id:             str
    text:                str
    author_name:         Optional[str]  = None
    group_name:          Optional[str]  = None
    human_label:         Optional[str]  = None
    tags_human_override: Optional[dict] = None
    scraped_at:          Optional[str]  = None
    is_duplicate:        Optional[bool] = False


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"ok": True}


@app.get("/stats")
def stats():
    with get_db() as conn:
        total     = conn.execute("SELECT COUNT(*) FROM labeled_posts").fetchone()[0]
        rentals   = conn.execute(
            "SELECT COUNT(*) FROM labeled_posts WHERE human_label = 'rental'"
        ).fetchone()[0]
        not_rent  = conn.execute(
            "SELECT COUNT(*) FROM labeled_posts WHERE human_label = 'not_rental'"
        ).fetchone()[0]
        with_tags = conn.execute(
            "SELECT COUNT(*) FROM labeled_posts WHERE price IS NOT NULL OR rooms IS NOT NULL"
        ).fetchone()[0]

    training_threshold = 500
    return {
        "total_labeled":        total,
        "rental":               rentals,
        "not_rental":           not_rent,
        "with_extracted_tags":  with_tags,
        "training_threshold":   training_threshold,
        "still_needed":         max(0, training_threshold - total),
        "percent_to_threshold": round(min(100, total / training_threshold * 100), 1),
    }


@app.post("/label")
def save_label(payload: LabelPayload):
    # Duplicates have identical content to an already-stored post.
    # They add no training signal — skip them.
    if payload.is_duplicate:
        return {"ok": True, "skipped": "duplicate"}

    tags = payload.tags_human_override or {}

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO labeled_posts
                (post_id, text, author_name, group_name, human_label,
                 price, rooms, size, entry_date,
                 roommates, broker, scraped_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(post_id) DO UPDATE SET
                human_label   = excluded.human_label,
                price         = excluded.price,
                rooms         = excluded.rooms,
                size          = excluded.size,
                entry_date    = excluded.entry_date,
                roommates     = excluded.roommates,
                broker        = excluded.broker,
                synced_at     = excluded.synced_at
            """,
            (
                payload.post_id,
                payload.text,
                payload.author_name,
                payload.group_name,
                payload.human_label,
                tags.get("price"),
                tags.get("rooms"),
                tags.get("size"),
                tags.get("entry_date"),
                _bool_to_int(tags.get("roommates")),
                _bool_to_int(tags.get("broker")),
                payload.scraped_at,
                _now(),
            ),
        )
        conn.commit()

    return {"ok": True}


@app.post("/import-bulk")
def import_bulk(posts: list[dict]):
    """
    Accepts the raw JSON array produced by the dashboard Export button.
    Skips posts without a human_label and skips duplicates.
    Safe to run multiple times (upserts on post_id).

    Usage:
        curl -X POST http://localhost:8765/import-bulk
             -H "Content-Type: application/json"
             -d @C:\\path\\to\\export.json
    """
    imported = 0
    skipped  = 0

    with get_db() as conn:
        for post in posts:
            # Skip unlabeled posts — they contribute nothing to training.
            if not post.get("human_label"):
                skipped += 1
                continue

            # Skip duplicates — identical content to an already-stored post;
            # training on them twice would skew the model for no benefit.
            if post.get("is_duplicate"):
                skipped += 1
                continue

            # Prefer tags_human_override (user-corrected) over AI tags.
            tags = post.get("tags_human_override") or post.get("tags") or {}

            conn.execute(
                """
                INSERT INTO labeled_posts
                    (post_id, text, author_name, group_name, human_label,
                     price, rooms, size, entry_date,
                     roommates, broker, scraped_at, synced_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(post_id) DO UPDATE SET
                    human_label   = excluded.human_label,
                    price         = excluded.price,
                    rooms         = excluded.rooms,
                    size          = excluded.size,
                    entry_date    = excluded.entry_date,
                    roommates     = excluded.roommates,
                    broker        = excluded.broker,
                    synced_at     = excluded.synced_at
                """,
                (
                    post.get("post_id", ""),
                    post.get("text", ""),
                    post.get("author_name"),
                    post.get("group_name"),
                    post.get("human_label"),
                    tags.get("price"),
                    tags.get("rooms"),
                    tags.get("size"),
                    tags.get("entry_date"),
                    _bool_to_int(tags.get("roommates")),
                    _bool_to_int(tags.get("broker")),
                    post.get("scraped_at"),
                    _now(),
                ),
            )
            imported += 1

        conn.commit()

    return {"ok": True, "imported": imported, "skipped": skipped}


# ── Helpers ────────────────────────────────────────────────────────────────────

def _bool_to_int(val):
    if val is True:  return 1
    if val is False: return 0
    return None

def _now():
    return datetime.now(timezone.utc).isoformat()
