"""tinycsv - internal CSV helpers (vendored from acme-platform 2.3, do not fork casually)."""
import csv

DEFAULT_ENCODING = "utf-8"


def sniff_delimiter(sample, default=","):
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        return default


def _clean(value):
    return value.strip() if isinstance(value, str) else value


def read_rows(path, encoding=DEFAULT_ENCODING, delimiter=None):
    """Read a CSV file into a list of dicts with whitespace-trimmed keys and values."""
    with open(path, newline="", encoding=encoding) as fh:
        sample = fh.read(4096)
        fh.seek(0)
        delim = delimiter or sniff_delimiter(sample)
        reader = csv.DictReader(fh, delimiter=delim)
        return [{_clean(k): _clean(v) for k, v in row.items()} for row in reader]
