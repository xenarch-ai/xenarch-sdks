"""Category 1 bot detection — known AI crawler User-Agent matching."""

KNOWN_BOT_SIGNATURES: tuple[str, ...] = (
    # OpenAI
    "GPTBot",
    "OAI-SearchBot",
    "ChatGPT-User",
    # Anthropic
    "ClaudeBot",
    "anthropic-ai",
    # Perplexity
    "PerplexityBot",
    "Perplexity-User",
    # Google
    "Google-Extended",
    # ByteDance
    "Bytespider",
    # Amazon
    "Amazonbot",
    # Apple
    "Applebot-Extended",
    # Meta
    "Meta-ExternalAgent",
    # Others
    "CCBot",
    "cohere-ai",
    "YouBot",
    "DuckAssistBot",
    "Timpibot",
    "Diffbot",
    "Webz.io",
    "ImagesiftBot",
    "Omgili",
)

_SIGNATURES_LOWER: tuple[str, ...] = tuple(s.lower() for s in KNOWN_BOT_SIGNATURES)


def is_bot(user_agent: str | None) -> bool:
    """Check if a User-Agent string matches a known AI crawler.

    Case-insensitive substring match against known bot signatures.
    No IP verification in MVP.
    """
    if not user_agent:
        return False
    ua_lower = user_agent.lower()
    return any(sig in ua_lower for sig in _SIGNATURES_LOWER)
