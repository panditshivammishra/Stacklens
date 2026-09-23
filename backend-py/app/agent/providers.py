"""
─────────────────────────────────────────────────────────────────────────────
Multi-LLM provider adapters.

CONCEPT: The adapter (translator) pattern
  The ReAct loop speaks ONE neutral language (defined right here).
  Each AI company speaks its own dialect. One adapter per company translates:

      our loop ──neutral──► [GeminiAdapter]  ──Gemini dialect──►  Google
      our loop ──neutral──► [OpenAIAdapter]  ──OpenAI dialect──►  OpenAI / Groq / Ollama

  The loop never imports a vendor SDK. Add a company = add one adapter file
  section; the loop stays untouched.

THE NEUTRAL LANGUAGE
  message  = {"role": "user",      "text": str}
           | {"role": "assistant", "text": str}
           | {"role": "assistant", "tool_call": {"id", "name", "args"}}
           | {"role": "tool",      "id", "name", "result": <json>}
  tool spec = {"name", "description", "parameters": <JSON schema, lowercase>}
  reply     = {"type": "tool_call", "id", "name", "args"}
           | {"type": "text", "text"}

CONFIG (the "choose free or paid" knob) — .env:
  AGENT_MODELS=gemini:gemini-2.5-flash,openai:gpt-4o-mini
    comma list = failover chain: try the first; if its API errors, try the next.
  Free options:
    gemini:gemini-2.5-flash            (Google free tier — default)
    openai:llama-3.3-70b-versatile     + OPENAI_BASE_URL=https://api.groq.com/openai/v1 (Groq free tier)
    openai:llama3                      + OPENAI_BASE_URL=http://localhost:11434/v1      (Ollama, local, 100% free)
  Paid: openai:gpt-4o, gemini:gemini-2.5-pro, etc. Same one-line change.
─────────────────────────────────────────────────────────────────────────────
"""
import asyncio
import json
import uuid
from typing import Any, Protocol

from app import config

Message = dict[str, Any]
ToolSpec = dict[str, Any]
Reply = dict[str, Any]


class LLMProvider(Protocol):
    """What the ReAct loop needs from ANY provider — nothing more."""

    name: str

    async def chat(
        self, system: str, messages: list[Message], tools: list[ToolSpec]
    ) -> Reply: ...


# ─────────────────────────────────────────────────────────────────────────────
# Gemini adapter (google-generativeai SDK)
# ─────────────────────────────────────────────────────────────────────────────
class GeminiAdapter:
    def __init__(self, model: str, api_key: str):
        self.name = f"gemini:{model}"
        self._model_name = model
        self._api_key = api_key

    @staticmethod
    def _schema_to_gemini(schema: dict[str, Any]) -> dict[str, Any]:
        """JSON-schema lowercase types → Gemini's UPPERCASE enum names."""
        out: dict[str, Any] = {}
        for key, value in schema.items():
            if key == "type":
                out[key] = str(value).upper()
            elif key == "properties":
                out[key] = {k: GeminiAdapter._schema_to_gemini(v) for k, v in value.items()}
            elif key == "items":
                out[key] = GeminiAdapter._schema_to_gemini(value)
            else:
                out[key] = value
        return out

    def _to_gemini_history(self, messages: list[Message]) -> list[Any]:
        """Neutral messages → Gemini Content/parts (its envelope format)."""
        import google.generativeai as genai

        history: list[Any] = []
        for m in messages:
            if m["role"] == "user":
                history.append({"role": "user", "parts": [{"text": m["text"]}]})
            elif m["role"] == "assistant" and "tool_call" in m:
                tc = m["tool_call"]
                history.append(genai.protos.Content(
                    role="model",
                    parts=[genai.protos.Part(function_call=genai.protos.FunctionCall(
                        name=tc["name"], args=tc["args"],
                    ))],
                ))
            elif m["role"] == "assistant":
                history.append({"role": "model", "parts": [{"text": m["text"]}]})
            elif m["role"] == "tool":
                history.append(genai.protos.Content(
                    role="user",
                    parts=[genai.protos.Part(function_response=genai.protos.FunctionResponse(
                        name=m["name"], response={"result": m["result"]},
                    ))],
                ))
        return history

    async def chat(
        self, system: str, messages: list[Message], tools: list[ToolSpec]
    ) -> Reply:
        import google.generativeai as genai

        genai.configure(api_key=self._api_key)
        model = genai.GenerativeModel(
            self._model_name,
            system_instruction=system,
            tools=[{
                "function_declarations": [
                    {
                        "name": t["name"],
                        "description": t["description"],
                        "parameters": self._schema_to_gemini(t["parameters"]),
                    }
                    for t in tools
                ]
            }],
        )
        history = self._to_gemini_history(messages)

        # The Gemini SDK is blocking (no async) — run it on a side thread so
        # the event loop (serving HTTP + SSE) is never frozen while we wait.
        response = await asyncio.to_thread(model.generate_content, history)

        candidate = response.candidates[0]
        for part in candidate.content.parts:
            if part.function_call and part.function_call.name:
                return {
                    "type": "tool_call",
                    "id": str(uuid.uuid4()),  # Gemini has no call ids — invent one
                    "name": part.function_call.name,
                    "args": {k: v for k, v in part.function_call.args.items()},
                }
        text = "".join(p.text for p in candidate.content.parts if p.text)
        return {"type": "text", "text": text}


# ─────────────────────────────────────────────────────────────────────────────
# OpenAI-compatible adapter — covers OpenAI, Groq, Ollama, and every other
# provider that copied OpenAI's API shape (most of them did).
# ─────────────────────────────────────────────────────────────────────────────
class OpenAIAdapter:
    def __init__(self, model: str, api_key: str, base_url: str | None = None):
        self.name = f"openai:{model}"
        self._model = model
        self._api_key = api_key
        self._base_url = base_url

    def _to_openai_messages(self, system: str, messages: list[Message]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["text"]})
            elif m["role"] == "assistant" and "tool_call" in m:
                tc = m["tool_call"]
                out.append({"role": "assistant", "tool_calls": [{
                    "id": tc["id"],
                    "type": "function",
                    "function": {"name": tc["name"], "arguments": json.dumps(tc["args"])},
                }]})
            elif m["role"] == "assistant":
                out.append({"role": "assistant", "content": m["text"]})
            elif m["role"] == "tool":
                out.append({
                    "role": "tool",
                    "tool_call_id": m["id"],
                    "content": json.dumps(m["result"], default=str),
                })
        return out

    async def chat(
        self, system: str, messages: list[Message], tools: list[ToolSpec]
    ) -> Reply:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self._api_key, base_url=self._base_url)
        response = await client.chat.completions.create(
            model=self._model,
            messages=self._to_openai_messages(system, messages),
            tools=[{"type": "function", "function": t} for t in tools],
        )
        msg = response.choices[0].message
        if msg.tool_calls:
            call = msg.tool_calls[0]
            return {
                "type": "tool_call",
                "id": call.id,
                "name": call.function.name,
                "args": json.loads(call.function.arguments or "{}"),
            }
        return {"type": "text", "text": msg.content or ""}


# ─────────────────────────────────────────────────────────────────────────────
# The chain builder — reads AGENT_MODELS and returns the failover order.
# ─────────────────────────────────────────────────────────────────────────────
def build_provider_chain() -> list[LLMProvider]:
    chain: list[LLMProvider] = []
    for entry in config.AGENT_MODELS.split(","):
        entry = entry.strip()
        if not entry:
            continue
        provider, _, model = entry.partition(":")
        if provider == "gemini" and config.GEMINI_API_KEY:
            chain.append(GeminiAdapter(model, config.GEMINI_API_KEY))
        elif provider == "openai" and config.OPENAI_API_KEY:
            chain.append(OpenAIAdapter(model, config.OPENAI_API_KEY, config.OPENAI_BASE_URL))
    return chain
