"""Small routed Agent workflow for the web product."""

import asyncio
import base64
import binascii
import os
import re
import time
import uuid
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, field_validator

from .knowledge import KnowledgeCard, search_cards


DISCLAIMER = "本回答仅用于健康信息参考，不能替代医生诊断、检查或治疗。"
HIGH_RISK = re.compile(r"胸痛|胸闷.*气短|呼吸困难|意识不清|昏迷|肢体无力|口齿不清|剧烈头痛|大量出血")
RESEARCH = re.compile(r"指南|论文|文献|研究|证据|标准治疗|临床规范")
SYMPTOM = re.compile(r"疼|痛|发热|发烧|咳嗽|头晕|恶心|呕吐|气短|胸闷|呼吸|乏力")


class ChatRequest(BaseModel):
    message: str = Field(min_length=2, max_length=2000)
    session_id: str | None = Field(default=None, max_length=100)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=10)
    image: str | None = None

    @field_validator("image")
    @classmethod
    def validate_image(cls, value: str | None) -> str | None:
        if value is not None:
            if len(value) > 7_000_000 or not value.startswith(("data:image/jpeg;base64,", "data:image/png;base64,", "data:image/webp;base64,")):
                raise ValueError("仅支持不超过 5 MB 的 JPEG、PNG 或 WebP 图片")
            header, encoded = value.split(",", 1)
            try:
                raw = base64.b64decode(encoded, validate=True)
            except binascii.Error as exc:
                raise ValueError("图片编码无效") from exc
            valid = (
                (header.startswith("data:image/jpeg;") and raw.startswith(b"\xff\xd8\xff"))
                or (header.startswith("data:image/png;") and raw.startswith(b"\x89PNG\r\n\x1a\n"))
                or (header.startswith("data:image/webp;") and raw.startswith(b"RIFF") and raw[8:12] == b"WEBP")
            )
            if len(raw) > 5 * 1024 * 1024 or not valid:
                raise ValueError("图片格式或大小无效")
        return value


class Evidence(BaseModel):
    id: str
    title: str
    category: str
    excerpt: str
    source: str = "演示知识卡"


class TraceStep(BaseModel):
    label: str
    detail: str
    status: str = "done"


class ChatResponse(BaseModel):
    session_id: str
    answer: str
    route: str
    agents: list[str]
    evidence: list[Evidence]
    trace: list[TraceStep]
    high_risk: bool
    mode: str
    image_analyzed: bool
    elapsed_ms: int


def choose_agents(message: str) -> list[str]:
    has_research = bool(RESEARCH.search(message))
    has_symptoms = bool(SYMPTOM.search(message))
    has_risk = bool(HIGH_RISK.search(message))
    if has_research and (has_symptoms or has_risk):
        return ["症状分析", "循证检索", "健康咨询"]
    if has_research:
        return ["循证检索"]
    if has_risk or (has_symptoms and len(SYMPTOM.findall(message)) >= 2):
        return ["症状分析", "健康咨询"]
    return ["健康咨询"]


def demo_contribution(agent: str, cards: list[KnowledgeCard], high_risk: bool) -> str:
    selected = cards[0]
    if agent == "循证检索":
        return f"已找到与问题相关的演示知识卡：{selected.title}。当前卡片用于展示证据检索流程，不能代替最新临床指南。"
    if agent == "症状分析":
        return "问题包含需要关注的症状。" + ("出现高危信号，请优先联系当地急救服务或线下就医。" if high_risk else "建议结合起病时间、持续程度、伴随症状和既往病史，由医生进一步评估。")
    return f"{selected.summary} {selected.guidance}"


async def live_contribution(agent: str, request: ChatRequest, cards: list[KnowledgeCard]) -> str:
    base_url = os.environ["MEDIX_MODEL_BASE_URL"].rstrip("/")
    model = os.environ["MEDIX_MODEL_NAME"]
    api_key = os.environ["MEDIX_MODEL_API_KEY"]
    evidence = "\n".join(f"[{card.id}] {card.title}: {card.summary} {card.guidance}" for card in cards)
    system = (
        f"你是医疗信息助手中的{agent}。只提供一般健康信息，不作确定诊断、处方或剂量建议。"
        "必须说明不确定性，使用提供的证据时标注卡片编号。"
        "若出现胸痛、呼吸困难、意识改变等高危信号，建议立即联系当地急救服务。"
        f"\n参考知识卡（演示资料，非最新指南）：\n{evidence}"
    )
    content: list[dict[str, str]] = [{"type": "text", "text": request.message}]
    if request.image:
        content.append({"type": "image_url", "image_url": {"url": request.image}})  # type: ignore[arg-type]
    history = []
    for item in request.history[-6:]:
        if item.get("role") in {"user", "assistant"} and item.get("content"):
            history.append({"role": item["role"], "content": item["content"][:2000]})
    local_model = urlparse(base_url).hostname in {"127.0.0.1", "localhost", "::1"}
    async with httpx.AsyncClient(timeout=120 if local_model else 45, trust_env=not local_model) as client:
        response = await client.post(
            f"{base_url}/chat/completions",
            headers={"Authorization": f"Bearer {api_key}"},
            json={"model": model, "messages": [{"role": "system", "content": system}, *history, {"role": "user", "content": content}], "temperature": 0.2, "max_tokens": 550},
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"].strip()


async def respond(request: ChatRequest, mode: str) -> ChatResponse:
    started = time.monotonic()
    agents = choose_agents(request.message)
    cards = search_cards(request.message)
    high_risk = bool(HIGH_RISK.search(request.message))
    trace = [
        TraceStep(label="任务路由", detail="单 Agent 直达" if len(agents) == 1 else f"拆分为 {len(agents)} 个并行子任务"),
        TraceStep(label="知识检索", detail=f"BM25 召回 {len(cards)} 张演示知识卡"),
    ]
    if mode == "live":
        contributions = await asyncio.gather(*(live_contribution(agent, request, cards) for agent in agents))
    else:
        contributions = [demo_contribution(agent, cards, high_risk) for agent in agents]
    trace.extend(TraceStep(label=agent, detail="已完成分析") for agent in agents)

    sections = [f"【{agent}】\n{text}" for agent, text in zip(agents, contributions)]
    if request.image and mode == "demo":
        sections.insert(0, "【影像说明】\n已收到图片。演示模式不会分析图像内容，也不会依据图片给出判断。")
    if high_risk:
        sections.append("【风险提示】\n描述中包含可能需要及时处置的信号。若症状正在发生、持续或加重，请尽快联系当地急救服务或到线下医疗机构就诊。")
    sections.append(f"【说明】\n{DISCLAIMER}")
    trace.append(TraceStep(label="结果汇总", detail="合并专业视角并附风险提示"))

    return ChatResponse(
        session_id=request.session_id or str(uuid.uuid4()),
        answer="\n\n".join(sections),
        route="swarm" if len(agents) > 1 else "single",
        agents=agents,
        evidence=[Evidence(id=card.id, title=card.title, category=card.category, excerpt=card.summary) for card in cards],
        trace=trace,
        high_risk=high_risk,
        mode=mode,
        image_analyzed=bool(request.image and mode == "live"),
        elapsed_ms=round((time.monotonic() - started) * 1000),
    )
