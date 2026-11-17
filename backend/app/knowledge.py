"""Small, educational knowledge cards used by the public demo."""

from dataclasses import dataclass

import jieba
from rank_bm25 import BM25Okapi


@dataclass(frozen=True)
class KnowledgeCard:
    id: str
    title: str
    category: str
    summary: str
    guidance: str


CARDS = [
    KnowledgeCard("chest-pain", "胸痛与呼吸困难", "风险识别", "胸痛、明显呼吸困难、意识改变等症状需要优先评估紧急程度。", "若症状正在发生、持续或加重，应尽快联系当地急救服务或线下医疗机构。"),
    KnowledgeCard("fever", "发热咨询", "症状咨询", "发热的原因和风险取决于年龄、持续时间、体温及伴随症状。", "记录体温、持续时间及伴随症状；持续高热或出现意识变化、呼吸困难时及时就医。"),
    KnowledgeCard("cough", "咳嗽咨询", "症状咨询", "咳嗽需要结合持续时间、痰液、发热、呼吸情况及既往病史判断。", "记录症状变化；呼吸困难、咯血或持续加重时寻求医生评估。"),
    KnowledgeCard("headache", "头痛咨询", "症状咨询", "头痛应结合起病速度、严重程度、神经系统症状和既往病史。", "突发剧烈头痛，或合并肢体无力、言语不清时，应尽快就医。"),
    KnowledgeCard("hypertension", "高血压健康管理", "慢病管理", "血压判断需要规范测量和多次记录，单次读数不足以作出诊断。", "记录测量时间和数值，按医生建议复诊；不要自行停药或调整剂量。"),
    KnowledgeCard("diabetes", "糖尿病健康管理", "慢病管理", "血糖解释需要结合检测方式、进食时间、既往诊断与用药情况。", "保留连续记录并与医生讨论；出现明显意识异常时及时寻求帮助。"),
    KnowledgeCard("imaging", "医学影像问答", "影像解读", "影像观察需要原始清晰影像、拍摄体位、临床背景和专业报告共同判断。", "演示模式不会分析上传影像；正式解读应由具备资质的临床人员完成。"),
    KnowledgeCard("report", "检查报告理解", "报告解读", "检验参考范围会因实验室、年龄和临床状态不同而变化。", "解释异常指标时同时提供单位、参考范围及症状，避免只依据单一数值下结论。"),
    KnowledgeCard("medicine", "用药安全", "用药咨询", "药物名称、剂量、过敏史、妊娠状态及合并用药都会影响安全性。", "不要根据聊天回答自行开始、停用或调整处方药；请由医生或药师核对。"),
    KnowledgeCard("guideline", "临床指南与证据", "知识检索", "临床指南需核对来源、发布日期、适用人群与地区。", "知识卡仅用于演示检索流程，不代表最新临床指南或诊疗建议。"),
]


def tokenize(text: str) -> list[str]:
    return [part.strip().lower() for part in jieba.lcut(text) if part.strip()]


_index = BM25Okapi([tokenize(f"{card.title} {card.category} {card.summary} {card.guidance}") for card in CARDS])


def search_cards(query: str, limit: int = 3) -> list[KnowledgeCard]:
    scores = _index.get_scores(tokenize(query))
    ranked = sorted(zip(CARDS, scores), key=lambda item: item[1], reverse=True)
    matches = [card for card, score in ranked if score > 0][:limit]
    return matches or [CARDS[-1]]
