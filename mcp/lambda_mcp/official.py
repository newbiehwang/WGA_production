"""AWS 공식 MCP 서버(awslabs)의 도구를 이 Lambda MCP 서버에 붙인다.

공식 서버는 로컬 프로세스로 띄워(stdio) 쓰도록 만들어졌다. Lambda에서는 프로세스를 따로 띄우지 않고
서버 객체를 그대로 import해서, fastmcp의 in-memory 클라이언트로 같은 프로세스 안에서 부른다.

    LLM Lambda ──HTTP(JSON-RPC)──▶ LambdaMCPServer (lambda_mcp.py, 세션·전송은 그대로)
                                      ├─ 직접 만든 도구 (app.py의 @mcp_server.tool)
                                      └─ OfficialTools ──in-memory──▶ 공식 서버 객체 (CloudWatch, 문서, Cost Explorer, CloudTrail, Pricing)

in-memory 클라이언트로 부르는 이유
- Cost Explorer 서버(fastmcp)는 MCP 세션이 있어야 도구가 돈다 (ctx.info가 세션을 쓴다). 서버 객체의
  call_tool을 바로 부르면 "session is not available"로 실패한다. 클라이언트는 세션을 만들어 준다.
- 도구 안의 예외가 isError 결과로 돌아온다 (서버 객체를 바로 부르면 예외가 그대로 올라온다).
- CloudWatch·문서 서버(MCP SDK MCPServer)도 같은 방법으로 부를 수 있어 한 가지 경로로 모은다.

Lambda 핸들러는 동기 함수이고 공식 도구는 async다. 컨테이너마다 이벤트 루프 하나를 만들어 계속 쓴다
(요청마다 새 루프를 만들면 루프에 묶인 자원이 다음 요청에서 깨질 수 있다).

공식 서버는 도구 목록이 처음 필요할 때 불러온다 (Lambda 초기화 단계에서 불러오지 않는다)
- 공식 서버는 무겁다. CloudWatch 서버는 메트릭 분석 때문에 pandas·scipy·statsmodels까지 불러온다.
  Lambda는 컨테이너 이미지의 파일을 처음 읽을 때 받아 오므로, 콜드 스타트에서는 이 import가 10초를 넘는다.
- Lambda 초기화 단계는 10초로 제한되어 있고 늘릴 수 없다. 넘으면 그때까지 한 일을 버리고 첫 요청에서
  초기화를 처음부터 다시 한다. 초기화 단계에서 불러오면 10초를 버리고 같은 import를 한 번 더 하게 된다.
- 첫 요청에서 불러오면 한 번만 한다. 그 뒤로는 컨테이너가 살아 있는 동안 불러온 서버를 그대로 쓴다.
"""
import asyncio
import copy
import logging
import os
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# 공식 서버의 도구 중 이 서비스에서 빼는 것 (이유와 함께). 도구 설명이 길어서 도구 하나가 질문마다
# 수천 토큰을 쓰므로, 쓰임이 겹치거나 권한·전제가 맞지 않는 도구는 넣지 않는다.
EXCLUDED_TOOLS = {
    # CloudWatch PromQL: OpenTelemetry로 보낸 메트릭용이고, 호출하는 API(monitoring SigV4)의 IAM 권한이 문서에 없다
    "execute_promql_query": "PromQL",
    "execute_promql_range_query": "PromQL",
    "get_promql_label_values": "PromQL",
    "get_promql_series": "PromQL",
    "get_promql_labels": "PromQL",
    # 로그 인덱스 추천: 운영 질의응답보다 로그 설정 관리용이고 계정 정책 조회 권한이 더 필요하다
    "recommend_indexes_loggroup": "로그 인덱스 추천",
    "recommend_indexes_account": "로그 인덱스 추천",
    # 여러 쿼리 일괄 실행: execute_log_insights_query와 쓰임이 겹친다
    "execute_cwl_insights_batch": "execute_log_insights_query와 중복",
    # CloudTrail Lake: 스캔한 데이터만큼 쿼리 비용이 들고 이벤트 데이터 저장소(유료)가 있어야 한다.
    # 최근 90일 관리 이벤트 조회(lookup_events, 무료)만 쓴다
    "lake_query": "CloudTrail Lake (유료)",
    "get_query_status": "CloudTrail Lake (유료)",
    "get_query_results": "CloudTrail Lake (유료)",
    "list_event_data_stores": "CloudTrail Lake (유료)",
    # Pricing: 로컬 파일 경로를 받아 연다. Lambda 안에서는 자격 증명이 든 파일(/proc/self/environ 등)까지
    # 읽을 수 있어, 모델이 경로를 고르는 도구는 두지 않는다 (보안)
    "analyze_cdk_project": "로컬 파일 읽기 (보안)",
    "analyze_terraform_project": "로컬 파일 읽기 (보안)",
    # Pricing: 보고서를 파일로 쓴다. 보고서는 모델이 답변으로 쓰면 된다
    "generate_cost_report": "파일 쓰기",
    # Pricing: 수백 MB짜리 가격 파일의 내려받기 주소라 대화에 쓸모가 없다 (pricing:ListPriceLists 권한도 필요)
    "get_price_list_urls": "가격 파일 주소",
    # Pricing: Bedrock 설계 예시 글. 운영 질의응답과 관계가 적고 도구 목록만 늘린다
    "get_bedrock_patterns": "운영 질문과 무관",
}

# region 인자의 기본값이 버지니아 북부 리전으로 박혀 있는 도구. 모델이 region을 생략하면 이 Lambda의 리전을 쓰게 한다.
# (CloudWatch 도구들은 이미 AWS_REGION을 기본으로 쓴다. CloudTrail 조회는 리전별이라 다른 리전을 보면 '기록 없음'이 된다)
REGION_FROM_ENV_TOOLS = {"lookup_events"}


def _inline_refs(schema: Dict[str, Any]) -> Dict[str, Any]:
    """스키마의 $ref를 $defs의 내용으로 바꿔 넣고 $defs를 없앤다.

    공식 도구 일부(get_metric_data 등)는 pydantic이 만든 $defs/$ref를 쓴다. LLM Lambda는 도구 스키마를
    Anthropic·Bedrock 형식으로 옮길 때 properties만 가져가므로, 참조가 남아 있으면 가리킬 곳이 없어진다.
    """
    defs = schema.get("$defs", {})

    def resolve(node: Any, seen: Tuple[str, ...] = ()) -> Any:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/$defs/"):
                name = ref.split("/")[-1]
                if name in seen or name not in defs:  # 자기 자신을 가리키면 더 풀지 않는다
                    return {"type": "object"}
                extra = {k: v for k, v in node.items() if k != "$ref"}
                return {**resolve(defs[name], seen + (name,)), **extra}
            return {k: resolve(v, seen) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [resolve(item, seen) for item in node]
        return node

    return resolve(copy.deepcopy(schema))


def load_default_servers() -> List[Any]:
    """이 서비스가 쓰는 공식 서버: CloudWatch, AWS 문서, Cost Explorer, CloudTrail, Pricing. 부를 때 import한다 (무겁다)."""
    # 공식 서버는 import할 때 loguru로 로그를 남긴다. Lambda 로그가 넘치지 않게 경고 이상만 남긴다
    os.environ.setdefault("FASTMCP_LOG_LEVEL", "ERROR")
    # Lambda에서는 /tmp만 쓸 수 있고 패키지가 설치된 곳(site-packages)은 읽기 전용이다.
    # billing-cost-management 서버는 import하는 순간 로그 파일을 자기 설치 폴더(awslabs/logs)에 만들려고 해서,
    # 그대로 두면 "Read-only file system"으로 MCP Lambda가 시작하지 못한다. 로그 파일 위치를 /tmp로 옮긴다
    os.environ.setdefault("FASTMCP_LOG_FILE", "/tmp/billing-cost-management-mcp-server.log")
    # 같은 서버는 응답이 크면(기본 25KB) 설치 폴더에 SQLite 파일을 만들어 옮겨 두고, 그 표를 SQL 도구로
    # 다시 읽게 한다. 이 서비스는 SQL 도구를 붙이지 않았으므로 옮기지 말고 응답을 그대로 받는다
    # (Lambda 응답 한도 6MB보다 작게)
    os.environ.setdefault("MCP_SQL_THRESHOLD", str(5 * 1024 * 1024))
    from awslabs.aws_documentation_mcp_server.server_aws import mcp as documentation
    from awslabs.aws_pricing_mcp_server.server import mcp as pricing
    from awslabs.billing_cost_management_mcp_server.tools.cost_explorer_tools import cost_explorer_server
    from awslabs.cloudtrail_mcp_server.server import mcp as cloudtrail
    from awslabs.cloudwatch_mcp_server.server import mcp as cloudwatch

    return [cloudwatch, documentation, cost_explorer_server, cloudtrail, pricing]


class OfficialTools:
    """공식 서버 여러 개의 도구를 하나로 모아 목록을 주고, 이름으로 해당 서버에 호출을 넘긴다."""

    def __init__(self, load_servers: Callable[[], List[Any]], excluded: Optional[Dict[str, str]] = None,
                 region_from_env: Optional[set] = None):
        self._load_servers = load_servers  # 서버 목록을 돌려주는 함수. 도구 목록이 처음 필요할 때 부른다
        self._excluded = excluded or {}
        self._region_from_env = region_from_env or set()
        self._loop = asyncio.new_event_loop()
        self._schemas: Optional[Dict[str, Dict[str, Any]]] = None  # 도구 이름 → MCP 도구 정의
        self._routes: Dict[str, Any] = {}  # 도구 이름 → 서버 객체

    @classmethod
    def default(cls) -> "OfficialTools":
        """이 서비스가 쓰는 공식 서버를 붙인다. 여기서는 불러오지 않는다 (위 모듈 설명)."""
        return cls(load_default_servers, EXCLUDED_TOOLS, REGION_FROM_ENV_TOOLS)

    def _region(self) -> Optional[str]:
        return os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")

    def _with_env_region(self, name: str, schema: Dict[str, Any]) -> Dict[str, Any]:
        """region 기본값을 이 Lambda의 리전으로 바꾼 스키마 (모델이 읽는 설명도 함께)."""
        region = self._region()
        props = schema.get("properties", {})
        if name not in self._region_from_env or "region" not in props or not region:
            return schema
        schema = copy.deepcopy(schema)
        schema["properties"]["region"].update(
            default=region, description=f"AWS region to query. Defaults to {region} (this deployment's region).")
        return schema

    def _run(self, coro):
        return self._loop.run_until_complete(coro)

    async def _collect(self) -> None:
        from fastmcp import Client

        schemas: Dict[str, Dict[str, Any]] = {}
        for server in self._load_servers():
            async with Client(server) as client:
                for tool in await client.list_tools():
                    if tool.name in self._excluded:
                        continue
                    if tool.name in schemas:
                        raise ValueError(f"공식 MCP 도구 이름이 겹칩니다: {tool.name}")
                    definition = tool.model_dump(by_alias=True, exclude_none=True, mode="json")
                    schemas[tool.name] = {
                        "name": tool.name,
                        "description": definition.get("description", ""),
                        "inputSchema": self._with_env_region(
                            tool.name, _inline_refs(definition.get("inputSchema", {"type": "object"}))),
                    }
                    self._routes[tool.name] = server
        self._schemas = schemas

    def schemas(self) -> List[Dict[str, Any]]:
        """tools/list에 넣을 도구 정의. 처음 부를 때 공식 서버를 불러와 한 번만 모은다 (컨테이너가 살아 있는 동안 그대로)."""
        if self._schemas is None:
            self._run(self._collect())
        return list(self._schemas.values())

    def has(self, name: str) -> bool:
        self.schemas()
        return name in self._routes

    def call(self, name: str, arguments: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], bool]:
        """도구를 부르고 (MCP content 목록, 오류 여부)를 돌려준다. 도구 안의 오류도 예외가 아니라 결과로 온다."""
        from fastmcp import Client

        server = self._routes[name]
        # region을 생략하면 서버 기본값(버지니아 북부) 대신 이 Lambda의 리전을 넘긴다
        if name in self._region_from_env and not (arguments or {}).get("region") and self._region():
            arguments = {**(arguments or {}), "region": self._region()}

        async def call_once():
            async with Client(server) as client:
                return await client.call_tool(name, arguments or {}, raise_on_error=False)

        result = self._run(call_once())
        content = [item.model_dump(by_alias=True, exclude_none=True, mode="json") for item in result.content]
        if result.is_error:
            logger.warning("공식 MCP 도구 %s 오류: %s", name, content[:1])
        return content, bool(result.is_error)
