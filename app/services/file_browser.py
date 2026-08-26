import os
import shutil

from app.services import song_service

AUDIO_EXTS = {".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".opus", ".wma"}

# Candidate starting locations (only these and their subfolders are browsable).
_CANDIDATE_ROOTS = [
    os.path.join(os.path.expanduser("~"), "Music"),
    os.path.join(os.path.expanduser("~"), "Downloads"),
    os.path.join(os.path.expanduser("~"), "Desktop"),
    os.path.join(os.path.expanduser("~"), "Documents"),
    song_service.MEDIA_FOLDER,
]


def allowed_roots():
    seen = set()
    roots = []
    for r in _CANDIDATE_ROOTS:
        try:
            rp = os.path.realpath(os.path.abspath(r))
        except Exception:
            continue
        if os.path.isdir(rp) and rp not in seen:
            seen.add(rp)
            roots.append(rp)
    return roots


def _is_audio(path):
    return os.path.splitext(path)[1].lower() in AUDIO_EXTS


def _within(path, roots):
    rp = os.path.realpath(os.path.abspath(path))
    for root in roots:
        if rp == root:
            return True
        try:
            if os.path.commonpath([root, rp]) == root:
                return True
        except ValueError:
            continue
    return False


def list_dir(path):
    roots = allowed_roots()
    if not path:
        return {
            "path": None,
            "parent": None,
            "roots": [{"name": os.path.basename(r), "path": r} for r in roots],
            "items": [],
            "is_roots": True,
        }
    ap = os.path.realpath(os.path.abspath(path))
    if not _within(ap, roots) or not os.path.isdir(ap):
        raise ValueError("outside allowed directories")

    items = []
    for name in sorted(os.listdir(ap)):
        fp = os.path.join(ap, name)
        if os.path.isdir(fp):
            items.append({"name": name, "type": "dir", "path": fp})
        elif os.path.isfile(fp) and _is_audio(fp):
            try:
                size = os.path.getsize(fp)
            except OSError:
                size = None
            items.append({"name": name, "type": "file", "path": fp, "size": size})

    items.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
    parent = os.path.dirname(ap)
    return {
        "path": ap,
        "parent": parent if _within(parent, roots) else None,
        "roots": [{"name": os.path.basename(r), "path": r} for r in roots],
        "items": items,
        "is_roots": False,
    }


def import_paths(paths):
    roots = allowed_roots()
    imported = []
    for p in paths or []:
        ap = os.path.realpath(os.path.abspath(p))
        if not _within(ap, roots) or not os.path.isfile(ap) or not _is_audio(ap):
            continue
        try:
            imported.append(song_service.add_file_from_path(ap))
        except Exception:
            continue
    return imported
