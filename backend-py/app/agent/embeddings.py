"""
─────────────────────────────────────────────────────────────────────────────
Text embeddings — turns text into a vector of numbers for similarity search.

CONCEPT: what an embedding is
  A model reads a piece of text and outputs a fixed-length list of numbers
  (a "vector") that captures its MEANING, not its exact words. Two pieces of
  text about the same idea end up as two vectors that point in a similar
  direction in that space — "checkout endpoint timing out" and "payment API
  request taking too long" land close together even though they share almost
  no words. That's the entire trick RAG (Retrieval-Augmented Generation)
  relies on: turn "find similar text" into "find nearby points."

WHY THIS DOES NOT FAIL OVER BETWEEN PROVIDERS (unlike providers.py's chat chain)
  A vector from Gemini and a vector from OpenAI are different lengths, built by
  different models, and are NOT comparable — like a distance in meters and a
  distance measured in "number of my footsteps." Mixing them doesn't give a
  worse answer, it gives a MEANINGLESS one. So exactly one embedding model is
  picked, once, at startup, from whichever provider has a key configured — and
  every embedding ever stored or searched for the life of the deployment must
  come from that same model, or comparisons stop meaning anything.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio

from app import config

# A hung embedding call must not hang the caller forever. Without this, the
# Gemini SDK retries internally for minutes before giving up — which showed up
# as a 50-minute test run and would mean a background task quietly stuck in
# production. Fail fast instead; the caller already treats embedding as
# best-effort.
EMBED_TIMEOUT_S = 20

if config.GEMINI_API_KEY:
    EMBEDDING_PROVIDER = "gemini"
    EMBEDDING_MODEL = "models/gemini-embedding-001"
    EMBEDDING_DIM = 3072
elif config.OPENAI_API_KEY:
    EMBEDDING_PROVIDER = "openai"
    EMBEDDING_MODEL = "text-embedding-3-small"
    EMBEDDING_DIM = 1536
else:
    EMBEDDING_PROVIDER = None
    EMBEDDING_MODEL = None
    EMBEDDING_DIM = 0


async def embed_text(text: str) -> list[float]:
    """Text in, vector out. Raises if no embedding provider is configured."""
    if EMBEDDING_PROVIDER == "gemini":
        import google.generativeai as genai

        genai.configure(api_key=config.GEMINI_API_KEY)
        # Blocking SDK, same as GeminiAdapter.chat() in providers.py — run it on
        # a side thread so the event loop (serving HTTP + SSE) isn't frozen.
        result = await asyncio.to_thread(
            genai.embed_content,
            model=EMBEDDING_MODEL,
            content=text,
            request_options={"timeout": EMBED_TIMEOUT_S},
        )
        return result["embedding"]

    if EMBEDDING_PROVIDER == "openai":
        from openai import AsyncOpenAI

        client = AsyncOpenAI(
            api_key=config.OPENAI_API_KEY,
            base_url=config.OPENAI_BASE_URL,
            timeout=EMBED_TIMEOUT_S,
        )
        response = await client.embeddings.create(model=EMBEDDING_MODEL, input=text)
        return response.data[0].embedding

    raise RuntimeError(
        "No embedding provider configured — set GEMINI_API_KEY or OPENAI_API_KEY"
    )
