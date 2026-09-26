"""LLM 예상 비용: 질문 하나에 쓴 토큰에 모델 단가를 곱한다 (감사 로그의 질문 행, audit.py)

- 단가: Anthropic 공식 가격표 (https://platform.claude.com/docs/en/about-claude/pricing, 2026-09-27 확인). USD / 백만 토큰
- 토큰 요금만 센다: 할인·세금·데이터 위치(inference_geo) 할증은 넣지 않는다. 실제 청구액은 Anthropic 콘솔에서 본다
- 이 앱은 캐시 유효 시간을 정하지 않으므로(cache_control 없음) 캐시 쓰기는 5분 단가로 계산한다
- input_tokens에는 캐시에서 읽은·캐시에 쓴 입력이 들어 있지 않다 (API가 따로 준다). 그래서 네 가지를 더한다
- 단가표에 없는 모델(새 모델, Bedrock 모델 ID)은 비용을 비워 둔다 (0으로 적지 않는다). 새 모델이 나오면 여기에 더한다
- 비용은 마이크로달러(백만분의 1달러) 정수로 남긴다: DynamoDB는 float을 받지 않고, 정수는 Logs Insights에서 바로 더할 수 있다.
  단가가 USD / 백만 토큰이므로 토큰 수 × 단가가 곧 마이크로달러다
"""
import re
from decimal import ROUND_HALF_UP, Decimal
from typing import Dict, Optional

# 토큰 종류 (감사 로그의 tokens와 같은 이름)
KINDS = ("input", "output", "cacheWrite", "cacheRead")

# 모델 ID → 단가 (입력, 출력, 캐시 쓰기 5분, 캐시 읽기). 모델 ID 뒤에 날짜가 붙은 것(-20250929)도 같은 단가다.
# 이 앱은 요청할 때의 최신 Sonnet을 쓴다 (llm_service.current_model)
PRICES: Dict[str, Dict[str, str]] = {
    "claude-sonnet-5": {"input": "2", "output": "10", "cacheWrite": "2.50", "cacheRead": "0.20"},
    "claude-sonnet-4-6": {"input": "3", "output": "15", "cacheWrite": "3.75", "cacheRead": "0.30"},
    "claude-sonnet-4-5": {"input": "3", "output": "15", "cacheWrite": "3.75", "cacheRead": "0.30"},
    "claude-sonnet-4": {"input": "3", "output": "15", "cacheWrite": "3.75", "cacheRead": "0.30"},
}

_DATED = re.compile(r"(.+?)(-\d{8})?")


def price_of(model_id: Optional[str]) -> Optional[Dict[str, str]]:
    """모델의 단가 (USD / 백만 토큰, 글자). 모르는 모델이면 None.
    claude-sonnet-4-5-20250929 → claude-sonnet-4-5. 날짜만 떼므로 claude-sonnet-4-5가 claude-sonnet-4로 잘못 잡히지 않는다."""
    match = _DATED.fullmatch(model_id or "")
    return PRICES.get(match.group(1)) if match else None


def cost_micro_usd(model_id: Optional[str], tokens: Dict[str, int]) -> Optional[int]:
    """토큰 네 종류의 예상 비용 (마이크로달러, 반올림). 모르는 모델이면 None."""
    price = price_of(model_id)
    if price is None:
        return None
    total = sum(Decimal(int(tokens.get(kind) or 0)) * Decimal(price[kind]) for kind in KINDS)
    return int(total.quantize(Decimal(1), rounding=ROUND_HALF_UP))
