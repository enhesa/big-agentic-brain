from collections import Counter


def _event_tags(event):
    # an event can carry the same tag twice (UI bug upstream); count each tag once per event
    return {t.strip().lower() for t in event.get("tags", []) if t.strip()}


def top_tags(events, n=3):
    """Most used tags, most frequent first. Ties are broken alphabetically."""
    counts = Counter()
    for e in events:
        counts.update(_event_tags(e))
    return [tag for tag, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]]


def render_digest(user, events):
    lines = [f"Hi {user}, this week you had {len(events)} events."]
    tags = top_tags(events)
    if tags:
        lines.append("Top tags: " + ", ".join(tags))
    return "\n".join(lines)
