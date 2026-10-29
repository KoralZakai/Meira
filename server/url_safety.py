"""May the server fetch this URL? Only if it is on the public internet.

The dead-link check (main._strip_dead_links) fetches every URL in the model's
reply. That reply can carry text someone else wrote (web results, invites), so
"http://169.254.169.254/…" or "http://localhost:8000/admin" would have been
fetched from INSIDE the Fly machine, redirects followed. Nothing came back to
her except "link removed", but a request from inside is the whole attack.

So a URL is fetched only when its scheme is http(s) and EVERY address its host
resolves to is public; redirects are followed by hand and each hop re-checked.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)


def _public_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


async def is_public_url(url: str) -> bool:
    """True only for http(s) URLs whose host resolves to public addresses only."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    host = parts.hostname
    try:
        ipaddress.ip_address(host)
        return _public_ip(host)
    except ValueError:
        pass
    if host == "localhost" or host.endswith((".localhost", ".internal", ".local")):
        return False
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host, parts.port or (443 if parts.scheme == "https" else 80),
            type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    addrs = {info[4][0] for info in infos}
    if not addrs or not all(_public_ip(a) for a in addrs):
        logger.warning("SECURITY: refused to fetch %s — resolves to a non-public address", host)
        return False
    return True
