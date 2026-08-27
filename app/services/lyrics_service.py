from app.database.database import get_connection


def get_lyrics(song_id):
    conn = get_connection()
    row = conn.execute("SELECT text, updated_at FROM lyrics WHERE song_id = ?", (song_id,)).fetchone()
    conn.close()
    if not row:
        return {"song_id": song_id, "text": "", "updated_at": None}
    return {"song_id": song_id, "text": row["text"] or "", "updated_at": row["updated_at"]}


def save_lyrics(song_id, text):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT OR REPLACE INTO lyrics (song_id, text, updated_at) VALUES (?, ?, datetime('now'))",
        (song_id, text),
    )
    conn.commit()
    conn.close()
    return True
