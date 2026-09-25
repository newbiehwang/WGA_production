"""결과물(차트·다이어그램): 모델에는 짧은 참조만 주고, 실제 주소와 그릴 내용은 화면에 따로 준다.

    MCP 결과물 도구 ──{url: presigned URL, s3_key, spec?}──▶ Artifacts.take
         ├─ 모델에게: {ref: "artifact://charts/2026/09/26/bar_ab12cd34.png"} (주소·데이터 없이)
         │     모델은 답변에 ![제목](artifact://…)로 넣는다
         └─ 화면에게: inference.artifacts = [{ref, url, kind, spec?}]
               화면이 참조를 찾아 차트는 ECharts로 그리고(spec), 나머지는 이미지(url)로 보인다

왜 주소를 모델에 주지 않나
- presigned URL에는 임시 자격 증명의 액세스 키 ID(ASIA…)와 버킷 이름의 계정 ID가 들어 있다.
  도구 결과는 Claude로 나가기 전에 가려지므로(redaction.py) 모델이 받은 주소는 이미 망가져 있고,
  모델이 답변에 옮겨 적은 이미지는 열리지 않았다. 가리지 않고 넘기면 자격 증명의 일부가 계정 밖으로 나간다.
- 1KB가 넘는 주소를 모델이 한 글자도 틀리지 않고 옮겨 적는다는 보장도 없다.
- 차트 데이터(spec)는 모델이 방금 넘긴 값이라 다시 돌려줄 필요가 없다 (토큰만 쓴다).

화면은 서버가 만든 이 목록의 주소만 이미지로 연다. 모델이 쓴 다른 이미지 주소는 열지 않는다
(답변 속 이미지 주소에 데이터를 실어 보내는 반출을 막는다: frontend utils/markdown.ts).
"""
import json
import re
from collections import OrderedDict
from typing import Any, Dict, List, Optional

REF_PREFIX = "artifact://"
MAX_ARTIFACTS = 8  # 답변 하나에 담는 결과물 수 (대화 기록 크기)
MAX_SPEC_TOTAL = 48000  # 답변 하나의 spec 합계 (글자). 넘는 것은 PNG로만 보인다
REF_PATTERN = re.compile(r"artifact://[A-Za-z0-9/_.\-]+")


def _body(result: Any) -> Optional[Dict[str, Any]]:
    """MCP 결과({content: [{type: text, text: JSON}]})의 JSON. 아니면 None."""
    try:
        block = (result or {}).get("content", [])[0]
        body = json.loads(block.get("text", ""))
    except (AttributeError, IndexError, TypeError, ValueError):
        return None
    return body if isinstance(body, dict) else None


class Artifacts:
    """요청 하나에서 만든 결과물 (llm_service가 요청마다 새로 만든다)."""

    def __init__(self):
        self.items: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
        self._spec_chars = 0

    def take(self, tool_name: str, result: Any) -> Any:
        """결과물 도구의 결과에서 주소·spec을 떼어 두고, 모델에 줄 결과(참조만)를 돌려준다.
        모르는 모양이거나 실패한 결과는 그대로 돌려준다."""
        body = _body(result)
        if not body or body.get("status") != "success" or not body.get("url") or not body.get("s3_key"):
            return result
        key = str(body["s3_key"])
        if not re.fullmatch(r"[A-Za-z0-9/_.\-]+", key):
            return result  # 참조로 쓸 수 없는 키: 예전처럼 둔다 (가리기를 거쳐 모델에 간다)
        ref = REF_PREFIX + key
        if ref not in self.items and len(self.items) >= MAX_ARTIFACTS:
            return {"isError": True, "content": [{"type": "text", "text": json.dumps({
                "status": "error",
                "message": f"답변 하나에 결과물은 {MAX_ARTIFACTS}개까지 넣을 수 있습니다. 꼭 필요한 것만 만드세요."},
                ensure_ascii=False)}]}

        item = {"ref": ref, "url": str(body["url"]), "kind": "chart" if body.get("chart_type") else "diagram",
                "tool": tool_name}
        spec = body.get("spec")
        if isinstance(spec, dict):
            size = len(json.dumps(spec, ensure_ascii=False, default=str))
            if self._spec_chars + size <= MAX_SPEC_TOTAL:
                item["spec"] = spec
                self._spec_chars += size
        self.items[ref] = item

        for_model = {k: v for k, v in body.items() if k not in ("url", "spec", "s3_key")}
        for_model["ref"] = ref
        for_model["message"] = (f"{body.get('message') or 'Generated.'} Put it in the answer exactly as "
                                f"![title]({ref}) - copy the ref as is; the screen replaces it with the image.")
        return {**result, "content": [{"type": "text", "text": json.dumps(for_model, ensure_ascii=False)}]}

    def public(self) -> List[Dict[str, Any]]:
        """답변의 inference.artifacts (화면이 참조를 풀어 그린다)."""
        return [{k: v for k, v in item.items() if k != "tool"} for item in self.items.values()]

    def with_urls(self, text: str) -> str:
        """참조를 실제 주소로 바꾼 글 (Slack처럼 참조를 풀 수 없는 곳에 보낼 때). 모르는 참조는 그대로 둔다."""
        return REF_PATTERN.sub(lambda m: self.items[m.group(0)]["url"] if m.group(0) in self.items else m.group(0),
                               text or "")
