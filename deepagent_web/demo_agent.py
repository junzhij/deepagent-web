"""A built-in demo deep agent.

The demo uses a *real* `deepagents` graph (planning, subagents, virtual
filesystem) but drives it with a scripted chat model, so the visualiser can be
explored without an API key. Swap the model for a real one (e.g.
``anthropic:claude-sonnet-5-5``) and the very same agent runs for real.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import textwrap
from collections.abc import AsyncIterator, Iterator, Sequence
from typing import Any

from langchain.agents.middleware import TodoListMiddleware
from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool

DEMO_MODEL = "demo"

RESEARCHER_PROMPT = """ROLE: researcher
You are a focused research subagent. Use `web_search` to gather facts about the
topic you are given, save your notes to the virtual filesystem under
/research/, then reply with a concise summary of what you found."""

CRITIC_PROMPT = """ROLE: critic
You are a critical reviewer. Read the research notes under /research/, look for
gaps, contradictions and unsupported claims, write your review to
/research/critique.md and reply with the key issues."""

MAIN_PROMPT = """You are a research lead. For any non-trivial request:
1. Plan the work with `write_todos`.
2. Delegate research to `researcher` subagents (in parallel when the topics are independent).
3. Ask the `critic` subagent to review the findings.
4. Write the final report to /report.md and give the user a short answer."""


# --------------------------------------------------------------------------- tools


@tool
async def web_search(query: str, max_results: int = 3) -> str:
    """Search the web and return the top results for a query."""
    key = os.environ.get("TAVILY_API_KEY")
    if key:
        import httpx

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                "https://api.tavily.com/search",
                json={"query": query, "max_results": max_results},
                headers={"Authorization": f"Bearer {key}"},
            )
            resp.raise_for_status()
            results = resp.json().get("results", [])
        return "\n\n".join(
            f"[{i + 1}] {r.get('title')}\n{r.get('url')}\n{r.get('content')}" for i, r in enumerate(results)
        )

    await asyncio.sleep(0.6 * _delay_factor())
    return (
        "(offline mock results - set TAVILY_API_KEY for real search)\n\n"
        + "\n\n".join(
            f"[{i + 1}] {title} - {query}\nhttps://example.org/{_slug(query)}/{i + 1}\n{body}"
            for i, (title, body) in enumerate(
                [
                    ("Overview", f"A broad introduction to {query}, covering definitions and history."),
                    ("Analysis", f"Practitioners discuss trade-offs and open problems around {query}."),
                    ("Survey", f"A survey summarising recent work and adoption of {query}."),
                ][:max_results]
            )
        )
    )


# --------------------------------------------------------------------------- scripted model


def _delay_factor() -> float:
    try:
        return float(os.environ.get("DEMO_DELAY", "1"))
    except ValueError:
        return 1.0


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:40] or "topic"


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in content)
    return str(content)


def _call(name: str, args: dict[str, Any], idx: int) -> dict[str, Any]:
    return {"name": name, "args": args, "id": f"call_{name}_{idx}_{os.urandom(3).hex()}", "type": "tool_call"}


class ScriptedDemoModel(BaseChatModel):
    """Deterministic chat model that plays out a multi-agent research workflow."""

    @property
    def _llm_type(self) -> str:
        return "deepagent-web-demo"

    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedDemoModel:
        return self

    # -- script -------------------------------------------------------------------

    def _next(self, messages: list[BaseMessage]) -> AIMessage:
        system = " ".join(_text(m.content) for m in messages if m.type == "system")
        human = next((_text(m.content) for m in messages if m.type == "human"), "")
        step = sum(1 for m in messages if m.type == "ai")
        if "ROLE: researcher" in system:
            return self._researcher(human, step)
        if "ROLE: critic" in system:
            return self._critic(step)
        return self._lead(human, step)

    def _lead(self, prompt: str, step: int) -> AIMessage:
        topic = textwrap.shorten(prompt.strip() or "the topic", 80, placeholder="...")
        todo = [
            f"Research background on {topic}",
            f"Research recent developments in {topic}",
            "Review the findings for gaps",
            "Write the final report to /report.md",
        ]

        def todos(*statuses: str) -> dict[str, Any]:
            return {"todos": [{"content": c, "status": s} for c, s in zip(todo, statuses, strict=True)]}

        script: list[tuple[str, list[dict[str, Any]]]] = [
            (
                "This needs a bit of research. Let me plan it out first.",
                [_call("write_todos", todos("in_progress", "in_progress", "pending", "pending"), 0)],
            ),
            (
                "The two research tracks are independent, so I'll run two researchers in parallel.",
                [
                    _call(
                        "task",
                        {
                            "subagent_type": "researcher",
                            "description": f"Research the background of: {topic}. Save notes to /research/background.md.",
                        },
                        1,
                    ),
                    _call(
                        "task",
                        {
                            "subagent_type": "researcher",
                            "description": f"Research recent developments in: {topic}. Save notes to /research/recent.md.",
                        },
                        2,
                    ),
                ],
            ),
            ("Both research tracks are done.", [_call("write_todos", todos("completed", "completed", "in_progress", "pending"), 3)]),
            (
                "Now I'll have the critic review the notes.",
                [
                    _call(
                        "task",
                        {
                            "subagent_type": "critic",
                            "description": "Review /research/background.md and /research/recent.md for gaps and weak claims.",
                        },
                        4,
                    )
                ],
            ),
            ("", [_call("write_todos", todos("completed", "completed", "completed", "in_progress"), 5)]),
            ("Let me pull the critique before writing the report.", [_call("read_file", {"file_path": "/research/critique.md"}, 6)]),
            (
                "",
                [
                    _call(
                        "write_file",
                        {
                            "file_path": "/report.md",
                            "content": textwrap.dedent(
                                f"""\
                                # Report: {topic}

                                ## Background
                                See /research/background.md. The topic has a well-documented history and
                                a stable set of core definitions.

                                ## Recent developments
                                See /research/recent.md. Adoption is growing and several open problems
                                remain active areas of work.

                                ## Caveats
                                The critic flagged that sources are few and partly secondary; claims
                                about adoption should be verified against primary data.
                                """
                            ),
                        },
                        7,
                    )
                ],
            ),
            (
                "Adding a sources section to the report.",
                [
                    _call(
                        "edit_file",
                        {
                            "file_path": "/report.md",
                            "old_string": "## Caveats",
                            "new_string": "## Sources\n- /research/background.md\n- /research/recent.md\n- /research/critique.md\n\n## Caveats",
                        },
                        8,
                    )
                ],
            ),
            ("", [_call("write_todos", todos("completed", "completed", "completed", "completed"), 9)]),
        ]
        if step < len(script):
            text, calls = script[step]
            return AIMessage(content=text, tool_calls=calls)
        return AIMessage(
            content=(
                f"Here's what I found on **{topic}**.\n\n"
                "- **Background:** the core concepts are well established and documented.\n"
                "- **Recent developments:** adoption is growing; several open problems remain.\n"
                "- **Caveats:** the critic flagged thin sourcing, so treat adoption figures with care.\n\n"
                "The full write-up is in `/report.md`, with notes under `/research/`."
            )
        )

    def _researcher(self, task: str, step: int) -> AIMessage:
        recent = "recent" in task.lower()
        path = "/research/recent.md" if recent else "/research/background.md"
        subject = re.sub(r"^Research (the background of|recent developments in):\s*", "", task).split(". Save")[0]
        queries = (
            [f"{subject} latest news", f"{subject} 2026 trends"]
            if recent
            else [f"{subject} overview", f"{subject} history"]
        )
        if step == 0:
            return AIMessage(content=f"Searching for '{queries[0]}'.", tool_calls=[_call("web_search", {"query": queries[0]}, 0)])
        if step == 1:
            return AIMessage(content="", tool_calls=[_call("web_search", {"query": queries[1]}, 1)])
        if step == 2:
            notes = textwrap.dedent(
                f"""\
                # {'Recent developments' if recent else 'Background'}: {subject}

                ## Sources
                - [1] Overview - {queries[0]}
                - [2] Analysis - {queries[1]}

                ## Notes
                - {'Adoption has accelerated over the last year.' if recent else 'Origins and core definitions are well documented.'}
                - {'Several groups report open problems with evaluation.' if recent else 'Main trade-offs are understood by practitioners.'}
                """
            )
            return AIMessage(content="", tool_calls=[_call("write_file", {"file_path": path, "content": notes}, 2)])
        return AIMessage(content=f"Done. Notes saved to {path}: two sources reviewed, key points summarised.")

    def _critic(self, step: int) -> AIMessage:
        if step == 0:
            return AIMessage(content="", tool_calls=[_call("ls", {"path": "/research"}, 0)])
        if step == 1:
            return AIMessage(
                content="Reading both notes files.",
                tool_calls=[
                    _call("read_file", {"file_path": "/research/background.md"}, 1),
                    _call("read_file", {"file_path": "/research/recent.md"}, 2),
                ],
            )
        if step == 2:
            review = textwrap.dedent(
                """\
                # Critique

                1. Only two sources per track, both secondary.
                2. The adoption claims in recent.md lack numbers.
                3. No counter-arguments are presented.
                """
            )
            return AIMessage(content="", tool_calls=[_call("write_file", {"file_path": "/research/critique.md", "content": review}, 3)])
        return AIMessage(content="Review written to /research/critique.md: sourcing is thin and adoption claims are unquantified.")

    # -- BaseChatModel plumbing -----------------------------------------------------

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._next(messages))])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        msg = self._next(messages)
        for chunk in self._chunks(msg):
            if run_manager and chunk.text:
                run_manager.on_llm_new_token(chunk.text, chunk=chunk)
            yield chunk

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        await asyncio.sleep(0.5 * _delay_factor())
        return self._generate(messages)

    async def _astream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: AsyncCallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[ChatGenerationChunk]:
        await asyncio.sleep(0.4 * _delay_factor())  # "time to first token"
        msg = self._next(messages)
        for chunk in self._chunks(msg):
            if chunk.text:
                await asyncio.sleep(0.03 * _delay_factor())
                if run_manager:
                    await run_manager.on_llm_new_token(chunk.text, chunk=chunk)
            yield chunk

    @staticmethod
    def _chunks(msg: AIMessage) -> Iterator[ChatGenerationChunk]:
        words = re.findall(r"\S+\s*|\s+", _text(msg.content))
        for word in words:
            yield ChatGenerationChunk(message=AIMessageChunk(content=word))
        n_in = 900 + 40 * len(words)
        yield ChatGenerationChunk(
            message=AIMessageChunk(
                content="",
                tool_call_chunks=[
                    {"name": c["name"], "args": json.dumps(c["args"]), "id": c["id"], "index": i}
                    for i, c in enumerate(msg.tool_calls)
                ],
                usage_metadata={"input_tokens": n_in, "output_tokens": 20 + 3 * len(words), "total_tokens": n_in + 20 + 3 * len(words)},
            )
        )


# --------------------------------------------------------------------------- factory


def build_demo_agent(model: str | BaseChatModel | None = None) -> Any:
    """Build the research deep agent. ``model`` of ``None``/``"demo"`` uses the scripted model."""
    from deepagents import create_deep_agent

    llm: str | BaseChatModel = ScriptedDemoModel() if model in (None, "", DEMO_MODEL) else model
    subagents = [
        {
            "name": "researcher",
            "description": "Researches one focused topic with web search and saves notes under /research/.",
            "system_prompt": RESEARCHER_PROMPT,
            "tools": [web_search],
        },
        {
            "name": "critic",
            "description": "Critically reviews research notes and writes /research/critique.md.",
            "system_prompt": CRITIC_PROMPT,
        },
    ]
    return create_deep_agent(
        model=llm,
        tools=[web_search],
        system_prompt=MAIN_PROMPT,
        subagents=subagents,
        middleware=[TodoListMiddleware()],
        name="research-lead",
    )
