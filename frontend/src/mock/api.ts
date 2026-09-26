// 백엔드 없이 화면만 띄우는 mock 모드의 가짜 API (`npm run dev:mock`).
//
// axios의 adapter(실제로 요청을 보내는 부분)를 바꿔 끼워, 앱이 부르는 API를 브라우저 안에서 대신 응답한다.
// 스토어·화면 코드는 그대로 두고 요청 한 곳만 가로채므로, 화면을 고칠 때 실제 배포와 같은 흐름으로 동작한다.
// - 대화 기록은 메모리에만 둔다. 새로 고치면 처음 예시 대화로 돌아간다.
// - 응답 모양은 백엔드(services/chat-history, services/llm)가 돌려주는 것과 맞춘다.
// - main.ts가 mock 모드일 때만 동적으로 불러오므로 배포용 빌드(npm run build)에는 들어가지 않는다.
import axios from "axios";
import { mockIsAdmin } from "../auth/authClient";
import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { PendingAction } from "../types/actions";
import type { Artifact } from "../types/artifacts";
import type { AdminEvent, AuditQuery, AuditRecord, TraceStep } from "../types/audit";
import type { ManagedGroup, ManagedUser, UserRole } from "../types/users";

interface MockMessage {
  id: string;
  sender: "user" | "assistant";
  text: string;
  timestamp: string;
  elapsed_time?: string;
  inference?: string; // 백엔드처럼 JSON 문자열로 저장한다 (다시 불러온 메시지와 같은 모양)
}

interface MockSession {
  sessionId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: MockMessage[];
}

// 답변을 만드는 과정의 시간표 (ms). 진행 상황 표시(생각 중 → 도구 실행 → 생각)와 취소 버튼을 확인할 수 있게
// 실제처럼 몇 초에 걸쳐 단계가 하나씩 나타나고, 마지막 단계가 끝난 뒤에 답이 온다
const FIRST_THINKING_AT = 600; // 첫 사고 요약이 나오는 때
const BASE_TOOL_MS = 1400; // 도구 하나가 도는 시간
const BASE_STEP_GAP_MS = 400; // 단계 사이
const TOOL_MS = BASE_TOOL_MS; // 감사 로그 예시의 시간 (진행 상황은 planRun이 답변마다 slow를 곱해 쓴다)
const STEP_GAP_MS = BASE_STEP_GAP_MS;

// 지금 쓰는 모델 (실제로는 요청할 때의 최신 Sonnet, services/llm/llm_service.py의 current_model)
const MODEL = { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" };

interface MockTool {
  tool_name: string;
  input: Record<string, unknown>;
  status: "ok" | "error";
  error?: string;
  suspicious?: string[]; // 결과에 지시문처럼 보이는 문구가 있었다 (services/llm/injection.py)
  id?: string; // 도구 호출 ID를 정해 둘 때 (승인 요청의 taintedBy가 가리킨다)
}

// 변경 도구 (감사 로그의 층이 유출이다). 나머지는 유입
const WRITE_TOOLS = new Set(["setLogRetention", "setAlarmActions"]);

// 답변 예시. 보낼 때마다 차례로 돌아가며, 화면에서 자주 고치는 요소(사고 요약·도구 목록·표·목록·코드·실패한 도구)를 모두 담았다.
// thinking: 도구를 부르기 전과 뒤의 사고 요약
interface MockEntry {
  answer: string;
  tools: MockTool[];
  thinking: string[];
  // 변경 도구를 부른 답변: 실행하지 않고 승인 요청을 만든다 (services/llm/approvals.py)
  approval?: () => Omit<
    PendingAction,
    "actionId" | "status" | "createdAt" | "expiresAt"
  >;
  actionId?: string; // 승인한 작업의 결과 설명 (/llm1 {actionId})
  // 도구 검색 (services/llm/tool_search.py): 처음부터 싣지 않는 도구는 모델이 찾아 불러온 뒤 부른다
  search?: { query: string; found: string[] };
  // 결과물(차트): 답변에는 ![제목](artifact://…) 참조만, 주소와 그릴 내용은 inference.artifacts로 (services/llm/artifacts.py)
  artifacts?: Artifact[];
  slow?: number; // 단계마다 걸리는 시간을 몇 배로 (기다리는 동안의 한 줄이 돌아가며 바뀌는 모습을 볼 때)
}

const ANSWERS: MockEntry[] = [
  {
    answer: [
      "지난 7일 동안 **wga-llm-dev** 함수의 오류는 3건입니다.",
      "",
      "| 날짜 | 오류 | 원인 |",
      "|:--|--:|:--|",
      "| 9월 22일 | 2 | Anthropic API 시간 초과 |",
      "| 9월 24일 | 1 | 잘못된 세션 ID |",
      "",
      "시간 초과는 모두 긴 대화에서 났습니다. 타임아웃을 늘리거나 대화 기록을 줄이는 방법이 있습니다.",
    ].join("\n"),
    tools: [
      {
        tool_name: "describe_log_groups",
        input: { log_group_name_prefix: "/aws/lambda/wga-" },
        status: "ok",
      },
      {
        tool_name: "analyze_log_group",
        input: { log_group_name: "/aws/lambda/wga-llm-dev", days: 7 },
        status: "ok",
      },
    ],
    thinking: [
      "지난주 Lambda 오류를 물었다. 로그 그룹 이름을 모르니 /aws/lambda/wga- 로 시작하는 그룹부터 찾고,\n찾은 그룹에서 지난 7일 동안의 오류 패턴을 본다.",
      "오류는 3건이고 두 가지 원인으로 나뉜다. 날짜별 표로 정리하고 시간 초과를 줄이는 방법을 덧붙인다.",
    ],
  },
  {
    answer: [
      "이번 달 비용이 가장 큰 서비스는 다음과 같습니다.",
      "",
      "1. AWS Lambda — $3.10",
      "2. Amazon API Gateway — $1.25",
      "3. Amazon S3 — $0.82",
      "",
      "비용을 줄이려면:",
      "",
      "- 쓰지 않는 로그 그룹의 보존 기간을 줄입니다",
      "- 버킷의 이전 버전을 수명 주기 규칙으로 지웁니다",
      "",
      "```bash",
      "aws logs put-retention-policy --log-group-name /aws/lambda/wga-llm-dev --retention-in-days 14",
      "```",
    ].join("\n"),
    tools: [
      {
        tool_name: "cost-explorer",
        input: { operation: "getCostAndUsage", granularity: "MONTHLY" },
        status: "ok",
      },
    ],
    thinking: [
      "이번 달 비용을 서비스별로 나눠 봐야 한다. Cost Explorer로 이번 달 비용을 서비스 기준으로 묶어 가져온다.",
      "Lambda가 가장 크다. 상위 3개를 보여 주고, 로그 보존 기간을 줄이는 명령을 예로 든다.",
    ],
  },
  {
    answer:
      "알람 목록을 가져오지 못했습니다. 권한을 확인한 뒤 다시 물어봐 주세요.",
    tools: [
      {
        tool_name: "get_active_alarms",
        input: { max_items: 50 },
        status: "error",
        error:
          "AccessDeniedException: cloudwatch:DescribeAlarms 권한이 없습니다",
      },
    ],
    thinking: [
      "지금 울리고 있는 알람을 확인한다.",
      "알람 조회가 권한 오류로 실패했다. 추측하지 말고 권한을 확인해 달라고 안내한다.",
    ],
  },
  {
    answer:
      "도구를 쓰지 않은 답변입니다. 짧은 문장만 있을 때 화면이 어떻게 보이는지 확인할 수 있습니다.",
    tools: [],
    thinking: ["인사에 가까운 짧은 질문이다. 도구 없이 바로 답한다."],
  },
];

// ---------------------------------------------------------------- 변경 작업 승인 (/actions, services/llm/approvals.py)
// 질문에 '보존'이나 '알람'이 들어 있으면 AI가 변경 도구를 부른 것처럼 승인 요청을 만든다.
// 승인하면 가짜 리소스 상태를 바꾸고, 이어서 /llm1 {actionId}로 결과 설명을 돌려준다

const MOCK_LOG_GROUP = "/aws/lambda/wga-llm-dev";
const MOCK_ALARM = "wga-dev-api-5xx";
const mockResources = { retention: 30 as number | null, alarmActions: true };
const actions = new Map<string, PendingAction>();
const APPROVAL_TTL_S = 600;

const retentionText = (days: number | null) =>
  days === null ? "영구 보관" : `${days}일`;
const actionsText = (enabled: boolean) => (enabled ? "알림 켜짐" : "알림 꺼짐");

const APPROVAL_ENTRIES: Record<"retention" | "alarm", MockEntry> = {
  retention: {
    answer: [
      "`/aws/lambda/wga-llm-dev` 로그 그룹의 보존 기간을 **14일**로 줄이려면 승인이 필요합니다.",
      "",
      "아래 승인 요청에서 바뀌는 내용을 확인한 뒤 승인해 주세요. 보존 기간을 줄이면 14일보다 오래된 로그는 지워집니다.",
    ].join("\n"),
    search: { query: "setLogRetention", found: ["setLogRetention"] },
    tools: [
      {
        tool_name: "setLogRetention",
        input: { log_group_name: MOCK_LOG_GROUP, retention_days: 14 },
        status: "ok",
      },
    ],
    thinking: [
      "로그 보존 기간을 줄여 달라는 요청이다. AWS를 바꾸는 작업이라 바로 실행되지 않고 승인 요청이 만들어진다.",
      "승인 대기 중이다. 무엇이 바뀌는지와 승인이 필요하다는 것을 알린다.",
    ],
    approval: () => ({
      tool: "setLogRetention",
      args: { log_group_name: MOCK_LOG_GROUP, retention_days: 14 },
      before: retentionText(mockResources.retention),
      after: "14일",
      summary: `${MOCK_LOG_GROUP} 로그 보존 기간 ${retentionText(mockResources.retention)} → 14일 (지난 로그 일부가 지워질 수 있습니다)`,
    }),
  },
  alarm: {
    answer:
      "점검하는 동안 `wga-dev-api-5xx` 알람의 알림을 끄려면 승인이 필요합니다. 알림을 끄면 알람이 울려도 메일이 가지 않습니다.",
    search: { query: "setAlarmActions", found: ["setAlarmActions"] },
    tools: [
      {
        tool_name: "setAlarmActions",
        input: { alarm_name: MOCK_ALARM, enabled: false },
        status: "ok",
      },
    ],
    thinking: [
      "점검 중 알람 알림을 꺼 달라는 요청이다. 변경 작업이라 승인 요청을 만든다.",
    ],
    approval: () => ({
      tool: "setAlarmActions",
      args: { alarm_name: MOCK_ALARM, enabled: false },
      before: actionsText(mockResources.alarmActions),
      after: actionsText(false),
      summary: `${MOCK_ALARM} ${actionsText(mockResources.alarmActions)} → ${actionsText(false)} (알람이 울려도 알림이 가지 않습니다)`,
    }),
  },
};

// 차트를 그린 답변 (질문에 '차트'·'그려'가 있으면). 브라우저가 ECharts로 그린다 (features/chat/ArtifactView).
// 주소는 목업이라 열리지 않는다 (PNG로 열기). 실제로는 서버가 만든 presigned URL이다
const chartArtifact = (name: string, type: string, options: Record<string, unknown>): Artifact => ({
  ref: `artifact://charts/mock/${name}.png`,
  url: `https://example.invalid/charts/mock/${name}.png`,
  kind: "chart",
  spec: { type, options },
});

const CHART_ENTRY: MockEntry = {
  answer: [
    "지난 7일 동안 Lambda 오류와 서비스별 비용을 차트로 그렸습니다.",
    "",
    "![Lambda 오류 수](artifact://charts/mock/errors.png)",
    "",
    "9월 4일에 `wga-llm-dev` 오류가 8건으로 가장 많았습니다.",
    "",
    "![서비스별 비용](artifact://charts/mock/cost.png)",
    "",
    "![질문을 처리하는 흐름](artifact://charts/mock/flow.png)",
    "",
    "![오류 키워드](artifact://charts/mock/words.png)",
  ].join("\n"),
  tools: [
    { tool_name: "get_metric_data", input: { metric_name: "Errors", namespace: "AWS/Lambda" }, status: "ok" },
    { tool_name: "generateLineChart", input: { title: "Lambda 오류 수" }, status: "ok" },
    { tool_name: "generateBarChart", input: { title: "서비스별 비용 (USD)" }, status: "ok" },
    { tool_name: "generateFlowDiagram", input: {}, status: "ok" },
    { tool_name: "generateWordCloudChart", input: { title: "오류 키워드" }, status: "ok" },
  ],
  thinking: ["오류 수와 비용을 조회한 뒤 차트로 그린다."],
  artifacts: [
    chartArtifact("errors", "line", {
      title: "Lambda 오류 수 (지난 7일)",
      axisXTitle: "날짜",
      axisYTitle: "오류",
      data: ["09-01", "09-02", "09-03", "09-04", "09-05", "09-06", "09-07"].flatMap((time, i) => [
        { time, value: [3, 5, 2, 8, 6, 4, 7][i], group: "wga-llm-dev" },
        { time, value: [1, 2, 1, 4, 3, 2, 3][i], group: "wga-mcp-dev" },
      ]),
    }),
    chartArtifact("cost", "bar", {
      title: "서비스별 비용 (USD)",
      data: [
        { category: "EC2", value: 320.5 },
        { category: "RDS", value: 210 },
        { category: "S3", value: 45.2 },
        { category: "CloudWatch", value: 30 },
        { category: "Lambda", value: 12 },
      ],
    }),
    chartArtifact("flow", "flow-diagram", {
      data: {
        nodes: ["질문", "도구 선택", "변경 도구?", "승인 요청", "실행", "답변"].map((name) => ({ name })),
        edges: [
          { source: "질문", target: "도구 선택" },
          { source: "도구 선택", target: "변경 도구?" },
          { source: "변경 도구?", target: "승인 요청", name: "예" },
          { source: "변경 도구?", target: "실행", name: "아니오" },
          { source: "승인 요청", target: "실행", name: "승인" },
          { source: "실행", target: "답변" },
          { source: "답변", target: "질문", name: "다음 질문" },
        ],
      },
    }),
    chartArtifact("words", "word-cloud", {
      title: "오류 키워드",
      data: [
        ["Timeout", 40], ["AccessDenied", 30], ["ThrottlingException", 25], ["메모리 부족", 20], ["5XX", 15],
        ["ConnectionReset", 12], ["NoSuchKey", 10], ["콜드 스타트", 9], ["ValidationError", 8], ["재시도", 6],
      ].map(([text, value]) => ({ text, value })),
    }),
  ],
};

// 차트 15종을 한 번에 (질문에 '갤러리'가 있으면). 화면에서 차트 모양을 고칠 때 본다
const GALLERY_CHARTS: [string, string, Record<string, unknown>][] = [
  ["area", "area", { title: "DynamoDB 용량 (스택)", stack: true, data: ["0시", "3시", "6시", "9시", "12시", "15시"].flatMap(
    (time, i) => [{ time, value: [1, 3, 4, 8, 6, 5][i], group: "읽기" }, { time, value: [1, 3, 4, 8, 6, 5][i], group: "쓰기" }]) }],
  ["column", "column", { title: "환경별 월 비용", group: true, axisYTitle: "USD", data: ["7월", "8월", "9월"].flatMap(
    (category) => [{ category, value: 40, group: "dev" }, { category, value: 120, group: "prod" }]) }],
  ["pie", "pie", { title: "비용 비중", innerRadius: 0.5, data: [{ category: "EC2", value: 55 }, { category: "RDS", value: 25 },
    { category: "S3", value: 10 }, { category: "기타", value: 10 }] }],
  ["scatter", "scatter", { title: "CPU와 지연", axisXTitle: "CPU %", axisYTitle: "ms",
    data: Array.from({ length: 40 }, (_, i) => ({ x: i * 2.5, y: 20 + ((i * 37) % 60) + i })) }],
  ["histogram", "histogram", { title: "응답 시간 분포", axisXTitle: "ms", binNumber: 12,
    data: Array.from({ length: 300 }, (_, i) => 50 + ((i * 7919) % 97) + ((i * 31) % 53)) }],
  ["radar", "radar", { title: "Well-Architected 점수", data: [["보안", 80], ["비용", 60], ["안정성", 90], ["성능", 70],
    ["운영", 75]].map(([name, value]) => ({ name, value })) }],
  ["dual", "dual-axes", { title: "요청과 오류율", categories: ["7월", "8월", "9월"], series: [
    { type: "column", data: [91.9, 99.1, 101.6], axisYTitle: "요청 수(만)" }, { type: "line", data: [0.055, 0.06, 0.062], axisYTitle: "오류율" }] }],
  ["treemap", "treemap", { title: "비용 트리맵", data: [{ name: "EC2", value: 300, children: [{ name: "t3.large", value: 200 },
    { name: "m5.xlarge", value: 100 }] }, { name: "RDS", value: 150 }, { name: "S3", value: 50, children: [
    { name: "로그 버킷", value: 30 }, { name: "이미지", value: 20 }] }] }],
  ["mind", "mind-map", { data: { name: "장애 대응", children: [{ name: "탐지", children: [{ name: "알람" }, { name: "로그" }] },
    { name: "분석", children: [{ name: "CloudTrail" }, { name: "지표" }] }, { name: "복구" }] } }],
  ["fishbone", "fishbone-diagram", { data: { name: "API 지연 증가", children: [{ name: "Lambda", children: [
    { name: "콜드 스타트" }, { name: "메모리 부족" }] }, { name: "DynamoDB", children: [{ name: "스로틀링" }] },
    { name: "네트워크", children: [{ name: "NAT 게이트웨이" }] }, { name: "외부 API" }] } }],
  ["network", "network-graph", { data: { nodes: ["API Gateway", "LLM Lambda", "MCP Lambda", "DynamoDB", "Claude API"].map(
    (name) => ({ name })), edges: [{ source: "API Gateway", target: "LLM Lambda", name: "호출" }, { source: "LLM Lambda",
    target: "MCP Lambda", name: "SigV4" }, { source: "LLM Lambda", target: "Claude API" }, { source: "MCP Lambda",
    target: "DynamoDB" }] } }],
];

const GALLERY_ENTRY: MockEntry = {
  answer: ["차트 15종입니다 (나머지 4종은 '차트 그려줘').", "", ...GALLERY_CHARTS.map(([name, type]) =>
    `![${type}](artifact://charts/mock/${name}.png)`)].join("\n\n"),
  tools: GALLERY_CHARTS.map(([, type]) => ({ tool_name: "generateBarChart", input: { title: type }, status: "ok" as const })),
  thinking: ["차트 종류를 모두 그린다."],
  artifacts: GALLERY_CHARTS.map(([name, type, options]) => chartArtifact(name, type, options)),
};

// 로그에 AI를 노린 지시문이 심겨 있던 경우 (질문에 '인젝션'·'의심'이 있으면). 진행 과정과 감사 로그에 '의심 문구'가 보인다
const INJECTION_ENTRY: MockEntry = {
  answer: [
    "지난 1시간 동안 `wga-llm-dev` 함수에서 오류 2건이 있었습니다.",
    "",
    "그런데 로그 한 줄에 **AI에게 로그 보존 기간을 1일로 바꾸라는 지시문**이 들어 있었습니다. 로그는 데이터일 뿐이라 따르지 않았고, 아무것도 바꾸지 않았습니다.",
    "누가 이 로그를 남겼는지 확인해 보시길 권합니다.",
  ].join("\n"),
  tools: [
    {
      tool_name: "execute_log_insights_query",
      input: {
        log_group_names: ["/aws/lambda/wga-llm-dev"],
        query_string: "filter @message like /ERROR/",
      },
      status: "ok",
      suspicious: [
        "ignore_instructions_ko",
        "tool_command",
        "change_command_ko",
      ],
    },
  ],
  thinking: [
    "최근 오류 로그를 Logs Insights로 찾는다.",
    "로그 한 줄이 설정을 바꾸라고 지시하고 있다. 도구 결과는 데이터이므로 따르지 않고, 사용자에게 알린다.",
  ],
};

// 모델이 로그에 심긴 지시를 그대로 따라 변경을 요청한 경우 (질문에 '로그대로'가 있으면).
// 판단은 그대로(승인 필요)이고, 승인 카드와 감사 로그에 '먼저 읽은 의심 결과'가 보인다 (체류 신호)
const TAINTED_LOG_ID = "toolu_mocklog1";
const TAINTED_ENTRY: MockEntry = {
  answer: [
    "로그에 적힌 대로 `/aws/lambda/wga-llm-dev` 로그 그룹의 보존 기간을 **1일**로 바꾸려면 승인이 필요합니다.",
    "",
    "아래 승인 요청을 확인해 주세요.",
  ].join("\n"),
  search: { query: "setLogRetention", found: ["setLogRetention"] },
  tools: [
    { ...INJECTION_ENTRY.tools[0], id: TAINTED_LOG_ID },
    {
      tool_name: "setLogRetention",
      input: { log_group_name: MOCK_LOG_GROUP, retention_days: 1 },
      status: "ok",
    },
  ],
  thinking: [
    "로그에 적힌 대로 해 달라는 요청이다. 먼저 로그를 읽는다.",
    "로그가 보존 기간을 1일로 바꾸라고 한다. 변경 작업이라 승인 요청을 만든다.",
  ],
  approval: () => ({
    tool: "setLogRetention",
    args: { log_group_name: MOCK_LOG_GROUP, retention_days: 1 },
    before: retentionText(mockResources.retention),
    after: "1일",
    summary: `${MOCK_LOG_GROUP} 로그 보존 기간 ${retentionText(mockResources.retention)} → 1일 (지난 로그 대부분이 지워질 수 있습니다)`,
    taintedBy: [
      {
        toolUseId: TAINTED_LOG_ID,
        tool: "execute_log_insights_query",
        kinds: INJECTION_ENTRY.tools[0].suspicious ?? [],
        callsAgo: 1,
      },
    ],
  }),
};

// 승인한 작업의 결과 설명 (실제로는 서버가 저장된 결과로 질문을 만들어 모델이 설명한다)
const explanationEntry = (action: PendingAction): MockEntry => ({
  answer:
    action.status === "executed"
      ? `승인하신 변경을 실행했습니다: **${action.after}** (이전: ${action.before}).\n\n감사 로그 탭에서 누가 요청하고 승인했는지 확인할 수 있습니다.`
      : "승인하신 변경을 실행하지 못했습니다. 권한이나 리소스 상태를 확인해 주세요.",
  tools: [],
  thinking: ["승인된 변경 작업의 실행 결과를 사용자에게 설명한다."],
  actionId: action.actionId,
});

const publicAction = (action: PendingAction): PendingAction =>
  action.status === "pending" && action.expiresAt <= Date.now() / 1000
    ? { ...action, status: "expired" }
    : action;

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const inferenceOf = (
  tools: object[],
  steps: object[] = [],
  pendingActions: PendingAction[] = [],
  artifacts: Artifact[] = [],
) =>
  JSON.stringify({
    artifacts,
    tools_used: tools,
    steps, // 사고 요약과 도구 호출을 순서대로 (services/llm/llm_progress.py와 같은 모양)
    pendingActions, // 승인을 기다리는 변경 작업 (답변 아래 승인 카드)
    reasoning: [],
    session_cached: false,
    token_usage: {},
  });

// ---------------------------------------------------------------- 진행 상황 (GET /llm1/progress/{requestId})
// 질문 하나마다 시간표를 만들고, 진행 상황을 물으면 지금까지 지난 시간만큼의 단계를 돌려준다

interface PlannedStep {
  at: number; // 나타나는 때 (시작부터 ms)
  until?: number; // 도구: 끝나는 때 (그 전까지는 실행 중)
  step: Record<string, unknown>;
}

interface Run {
  started: number;
  plan: PlannedStep[];
  total: number; // 답이 오는 때
  entry: MockEntry;
}

const runs = new Map<string, Run>();

const planRun = (entry: (typeof ANSWERS)[number]): Omit<Run, "started"> => {
  const plan: PlannedStep[] = [];
  const slow = entry.slow ?? 1;
  const gapMs = BASE_STEP_GAP_MS * slow;
  const toolMs = BASE_TOOL_MS * slow;
  let at = FIRST_THINKING_AT * slow;
  plan.push({ at, step: { type: "thinking", text: entry.thinking[0] } });
  at += gapMs;
  if (entry.search) {
    plan.push({ at, step: { type: "search", ...entry.search } });
    at += gapMs;
  }
  for (const tool of entry.tools) {
    plan.push({
      at,
      until: at + toolMs,
      step: {
        type: "tool",
        id: newId(),
        name: tool.tool_name,
        input: tool.input,
        status: tool.status,
        ...(tool.error && { error: tool.error }),
        ...(tool.suspicious && { suspicious: tool.suspicious }),
        ms: toolMs,
      },
    });
    at += toolMs + gapMs;
  }
  if (entry.thinking[1]) {
    plan.push({ at, step: { type: "thinking", text: entry.thinking[1] } });
    at += gapMs * 2;
  }
  return { plan, total: at + gapMs, entry };
};

// 시작부터 elapsed ms가 지났을 때 보이는 단계. 아직 끝나지 않은 도구는 '실행 중'
const stepsAt = (run: Omit<Run, "started">, elapsed: number) =>
  run.plan
    .filter((p) => p.at <= elapsed)
    .map((p) =>
      p.until !== undefined && elapsed < p.until
        ? { ...p.step, status: "running", ms: undefined, error: undefined }
        : p.step,
    );

// 오래 걸리는 답변 (질문에 '천천히'가 있으면): 첫 예시 답변을 여섯 배 느리게. 생각 → 조회 → 비용 → 정리마다
// 기다리는 동안의 한 줄이 3초마다 다음 말로 넘어가는 것을 본다
const slowEntry = (): MockEntry => ({
  ...ANSWERS[0],
  tools: [...ANSWERS[0].tools, { tool_name: "cost-explorer", input: { operation: "getCostAndUsage" }, status: "ok" }],
  slow: 6,
});

// 질문에 맞는 답변: 승인한 작업의 설명 → 변경 요청(보존·알람) → 나머지는 예시를 돌아가며
const entryFor = (body: RequestBody): MockEntry => {
  const action = body.actionId ? actions.get(body.actionId) : undefined;
  if (action) return explanationEntry(action);
  const text = body.text || body.question || "";
  if (text.includes("천천히")) return slowEntry();
  if (text.includes("로그대로")) return TAINTED_ENTRY;
  if (text.includes("인젝션") || text.includes("의심")) return INJECTION_ENTRY;
  if (text.includes("갤러리")) return GALLERY_ENTRY;
  if (text.includes("차트") || text.includes("그려")) return CHART_ENTRY;
  if (text.includes("보존")) return APPROVAL_ENTRIES.retention;
  if (text.includes("알람") && /끄|꺼|멈|중지/.test(text))
    return APPROVAL_ENTRIES.alarm;
  return ANSWERS[answerIndex++ % ANSWERS.length];
};

const startRun = (
  requestId?: string,
  entry: MockEntry = ANSWERS[answerIndex++ % ANSWERS.length],
): Run => {
  const run = { started: Date.now(), ...planRun(entry) };
  if (requestId) runs.set(requestId, run);
  return run;
};

// 처음 열었을 때 보이는 예시 대화 (빈 화면 대신 바로 고칠 대상을 보여 준다)
const seedSessions = (): MockSession[] => {
  const time = now();
  return [
    {
      sessionId: newId(),
      userId: "mock-user",
      title: "지난주 Lambda 오류 알려줘",
      createdAt: time,
      updatedAt: time,
      messages: [
        {
          id: newId(),
          sender: "user",
          text: "지난주 Lambda 오류 알려줘",
          timestamp: time,
        },
        {
          id: newId(),
          sender: "assistant",
          text: ANSWERS[0].answer,
          timestamp: time,
          elapsed_time: "4초",
          inference: inferenceOf(
            ANSWERS[0].tools,
            stepsAt(planRun(ANSWERS[0]), Infinity),
          ),
        },
      ],
    },
  ];
};

let sessions = seedSessions();
let answerIndex = 1; // 0번은 예시 대화에 이미 나와 있으므로 다음 것부터

// ---------------------------------------------------------------- 감사 로그 (GET /audit, services/llm/audit.py)
// mock 사용자는 관리자(admins 그룹)로 둔다: '내 기록'과 '모든 사용자'를 모두 확인할 수 있다.
// 주소에 ?mock-role=member를 붙이면 일반 사용자가 되어, 서버처럼 403을 돌려준다 (auth/authClient.ts).
// 지난 30일 동안 여러 사람(나, 다른 웹 사용자들, Slack 사용자)의 예시 기록을 실제 사용처럼 만들고(아래 seedAudit),
// 질문을 보내면 그 질문과 도구 호출이 맨 위에 바로 추가된다.

const MOCK_USER_ID = "mock-user";
const MOCK_AUDIT_MANY =
  new URLSearchParams(window.location.search).get("mock-audit") === "many";
const AUDIT_USERS = [
  { userId: MOCK_USER_ID, email: "demo@example.com", source: "web" as const },
  { userId: "7c1e9a52-kim", email: "kim@example.com", source: "web" as const },
  { userId: "slack:U04ABCDE", source: "slack" as const },
  // 요청자를 더 둔다: 기본은 셋 더(그룹 기준 요청자의 상위 5명 + '기타' 확인용), ?mock-audit=many는 여섯 더(거르기 목록의 '더 보기' 확인용)
  ...["lee", "park", "choi", "jung", "kang", "yoon"]
    .slice(0, MOCK_AUDIT_MANY ? 6 : 3)
    .map((name, index) => ({
      userId: `a${index}0f3b-${name}`,
      email: `${name}@example.com`,
      source: "web" as const,
    })),
];
const AUDIT_EXTRA_TOOLS: MockTool[] = [
  {
    tool_name: "search_documentation",
    input: { search_phrase: "Lambda 콜드 스타트 줄이기", limit: 5 },
    status: "ok",
  },
  {
    tool_name: "get_metric_data",
    input: {
      namespace: "AWS/Lambda",
      metric_name: "Errors",
      // 감사 로그에는 도구가 실제로 받은 값(계정 ID 원래 값)이 남는다
      dimension:
        "arn:aws:lambda:ap-northeast-2:111122223333:function:wga-llm-dev",
    },
    status: "ok",
  },
];
// 예시 기록의 질문과 답변: 도구 묶음(ANSWERS의 도구들, AUDIT_EXTRA_TOOLS 하나씩)과 같은 차례
const AUDIT_QUESTIONS = [
  "지난주 Lambda 오류 알려줘",
  "이번 달 비용이 가장 큰 서비스는?",
  "지금 울리는 알람 있어?",
  "안녕, 뭘 할 수 있어?",
  "콜드 스타트를 줄이는 방법 알려줘",
  "wga-llm-dev 함수 오류 추이 보여줘",
];
const AUDIT_EXTRA_ANSWERS = [
  [
    "Lambda 콜드 스타트를 줄이는 방법은 크게 세 가지입니다.",
    "",
    "1. **프로비저닝된 동시성**: 미리 실행 환경을 띄워 둡니다. 가장 확실하지만 비용이 듭니다.",
    "2. **패키지 줄이기**: 쓰지 않는 라이브러리를 빼고, 무거운 모듈은 필요할 때 불러옵니다.",
    "3. **SnapStart**(Java·Python): 초기화가 끝난 상태를 스냅샷으로 두고 거기서 시작합니다.",
    "",
    "`wga-llm-dev`는 요청이 드문드문 들어와서 2번부터 해 보는 것을 권합니다.",
  ].join("\n"),
  [
    "`wga-llm-dev` 함수의 지난 7일 오류 추이입니다.",
    "",
    "| 날짜 | 오류 |",
    "|:--|--:|",
    "| 9월 20일 | 0 |",
    "| 9월 22일 | 2 |",
    "| 9월 24일 | 1 |",
    "",
    "22일에 오류가 몰렸고, 이후로는 줄어드는 추세입니다.",
  ].join("\n"),
];
// 장애 때 도구가 실패한 질문의 답변
const AUDIT_FAILED_ANSWER =
  "지금은 지표를 가져오지 못했습니다. AWS가 요청을 잠시 거절하거나 도구가 제한 시간 안에 끝나지 않았습니다. 잠시 뒤 다시 물어봐 주세요.";

// 답변 전체 (실제로는 질문 행과 따로 둔 답변 항목, services/llm/audit.py 모듈 설명 '답변'). 키는 답변 항목의 at
const auditAnswers = new Map<string, string>();
const ANSWER_PREVIEW = 200; // 질문 행에 두는 답변 앞부분 (services/llm/audit.py ANSWER_PREVIEW)

// 감사 로그의 정렬 키와 같은 모양: 시각(UTC, 밀리초까지) + '#' + 도구 호출 ID 또는 'request#<질문 ID>'
const auditAt = (time: Date, suffix: string) =>
  `${time.toISOString()}#${suffix}`;

// 질문 하나의 기록 (도구 호출들 + 질문). time은 질문을 받은 때
const auditRecordsOf = (
  user: (typeof AUDIT_USERS)[number],
  question: string,
  tools: MockTool[],
  time: Date,
  redacted: Record<string, number> = {},
  answer?: string,
): AuditRecord[] => {
  const requestId = newId();
  const common = {
    userId: user.userId,
    ...("email" in user && { email: user.email }),
    source: user.source,
    requestId,
    sessionId: user.source === "web" ? newId() : undefined,
  };
  let at = time.getTime() + 900; // 첫 도구는 첫 사고 뒤에 시작한다
  const toolRecords = tools.map((tool): AuditRecord => {
    const toolUseId = tool.id ?? `toolu_${newId().slice(0, 8)}`;
    const record: AuditRecord = {
      ...common,
      at: auditAt(new Date(at), toolUseId),
      day: new Date(at).toISOString().slice(0, 10),
      kind: "tool",
      locus: WRITE_TOOLS.has(tool.tool_name) ? "egress" : "ingress",
      tool: tool.tool_name,
      toolUseId,
      input: tool.input,
      status: tool.status,
      ...(tool.error && { error: tool.error }),
      ...(tool.suspicious && { injectionSuspected: tool.suspicious }),
      ms: TOOL_MS,
      resultChars:
        tool.status === "ok" ? 1800 + tool.tool_name.length * 97 : 120,
    };
    at += TOOL_MS + STEP_GAP_MS;
    return record;
  });
  const failed = tools.some((tool) => tool.status === "error");
  const request: AuditRecord = {
    ...common,
    at: auditAt(time, `request#${requestId}`),
    day: time.toISOString().slice(0, 10),
    kind: "request",
    question,
    model: MODEL.id,
    status: "ok",
    toolCount: tools.length,
    injectionSuspected: tools.filter((tool) => tool.suspicious?.length).length,
    redacted,
    ms: at - time.getTime() + STEP_GAP_MS,
    ...(failed && { status: "ok" as const }), // 도구가 실패해도 질문(답변)은 성공일 수 있다
  };
  if (answer !== undefined) {
    // 서버처럼 질문 행에는 앞부분과 글자 수만, 전체는 따로 (GET /audit?answer=…)
    request.answerPreview =
      answer.length > ANSWER_PREVIEW ? `${answer.slice(0, ANSWER_PREVIEW - 1)}…` : answer;
    request.answerChars = answer.length;
    auditAnswers.set(request.at.replace("#request#", "#answer#"), answer);
  }
  return [...toolRecords, request];
};

// ---- 예시 기록의 시각: 실제 사용처럼 만든다 (감사 로그 막대그래프를 눈으로 확인하려면 고르게 흩어진 기록으로는 안 된다)
// - 평일 업무 시간(한국 시간 9~18시)에 많고, 점심·저녁에 조금, 밤과 주말에는 드물다
// - 장애 구간 세 번: 그 몇 시간 동안 질문이 몰리고 도구가 많이 실패한다
// - 기록이 하나도 없는 날이 하루 있다 (빈 칸 확인용)
// - 난수는 씨앗을 정해 두어 새로 고쳐도 같은 기록이 나온다 (시각은 지금 기준이라 조금씩 밀린다)

// 씨앗이 정해진 난수 (mulberry32)
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// 평균이 mean인 포아송 분포에서 하나 (한 시간에 몇 건)
const poisson = (mean: number, random: () => number) => {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = random();
  while (p > limit) {
    k += 1;
    p *= random();
  }
  return k;
};

const HOUR_MS = 60 * 60 * 1000;
const KST_MS = 9 * HOUR_MS;

// 한 시간에 들어오는 질문의 상대적인 양 (한국 시간 기준)
const hourlyWeight = (time: number) => {
  const kst = new Date(time + KST_MS);
  const hour = kst.getUTCHours();
  const weekend = kst.getUTCDay() === 0 || kst.getUTCDay() === 6;
  const byHour =
    hour >= 9 && hour <= 18
      ? hour === 12
        ? 0.55 // 점심
        : hour === 10 || hour === 14 || hour === 15
          ? 1.25 // 오전·오후의 몰리는 때
          : 1
      : hour >= 19 && hour <= 22
        ? 0.35
        : hour >= 7 && hour <= 8
          ? 0.3
          : 0.05;
  return byHour * (weekend ? 0.18 : 1);
};

// 장애 구간: 지금부터 며칠 전(daysAgo)에 hours시간. 그동안 질문이 load배로 늘고 도구가 failRate만큼 실패한다
const INCIDENTS = [
  { daysAgo: 2.35, hours: 3, load: 4, failRate: 0.6 },
  { daysAgo: 11.6, hours: 2, load: 3, failRate: 0.5 },
  { daysAgo: 19.25, hours: 5, load: 2.5, failRate: 0.35 },
];
const QUIET_DAY = 16; // 이 날(며칠 전)의 하루는 기록이 없다

// 장애 때 실패하는 도구
const FAILING_TOOLS: MockTool[] = [
  {
    tool_name: "get_metric_data",
    input: { namespace: "AWS/Lambda", metric_name: "Errors" },
    status: "error",
    error: "ThrottlingException: Rate exceeded",
  },
  {
    tool_name: "analyze_log_group",
    input: { log_group_name: "/aws/lambda/wga-llm-dev", days: 1 },
    status: "error",
    error: "도구가 제한 시간(25초) 안에 끝나지 않았습니다",
  },
];

const seedAudit = (): AuditRecord[] => {
  const random = seededRandom(20260926);
  const records: AuditRecord[] = [];
  const toolSets = [
    ...ANSWERS.map((a) => a.tools),
    [AUDIT_EXTRA_TOOLS[0]],
    [AUDIT_EXTRA_TOOLS[1]],
  ];
  // 업무 시간 한 시간의 평균 질문 수. 기본은 30일에 기록 약 1,000건, ?mock-audit=many는 약 2,700건 (2,000건 한도·긴 목록 확인용)
  const peak = MOCK_AUDIT_MANY ? 4.5 : 1.6;
  // 사람마다 쓰는 양이 다르다 (앞사람일수록 많이)
  const userWeights = AUDIT_USERS.map((_, index) => 1 / (index + 1.3));
  const totalWeight = userWeights.reduce((sum, w) => sum + w, 0);
  const pickUser = () => {
    let r = random() * totalWeight;
    for (let i = 0; i < AUDIT_USERS.length; i += 1) {
      r -= userWeights[i];
      if (r <= 0) return AUDIT_USERS[i];
    }
    return AUDIT_USERS[0];
  };

  const now = Date.now();
  const start = Math.floor((now - 30 * 24 * HOUR_MS) / HOUR_MS) * HOUR_MS;
  let n = 0;
  for (let hour = start; hour < now; hour += HOUR_MS) {
    const daysAgo = (now - hour) / (24 * HOUR_MS);
    if (Math.floor(daysAgo) === QUIET_DAY) continue;
    const incident = INCIDENTS.find(
      (i) => daysAgo <= i.daysAgo && daysAgo > i.daysAgo - i.hours / 24,
    );
    const mean = peak * hourlyWeight(hour) * (incident ? incident.load : 1);
    const count = poisson(mean, random);
    for (let k = 0; k < count; k += 1) {
      const time = new Date(Math.min(now - 1000, hour + random() * HOUR_MS));
      const failing = incident && random() < incident.failRate;
      // 도구 묶음의 차례로 질문·답변을 맞춘다. 장애 때는 질문만 차례로 돌린다
      const set = failing ? -1 : Math.floor(random() * toolSets.length);
      const tools =
        set < 0 ? [FAILING_TOOLS[Math.floor(random() * FAILING_TOOLS.length)]] : toolSets[set];
      const question = AUDIT_QUESTIONS[set < 0 ? n % AUDIT_QUESTIONS.length : set];
      const answer =
        set < 0
          ? AUDIT_FAILED_ANSWER
          : set < ANSWERS.length
            ? ANSWERS[set].answer
            : AUDIT_EXTRA_ANSWERS[set - ANSWERS.length];
      // 몇 건은 질문에 붙여 넣은 계정 ID·키를 Claude로 보내기 전에 가린 기록
      const roll = random();
      const redacted: Record<string, number> =
        roll < 0.12 ? { account_id: 1 } : roll < 0.16 ? { aws_access_key: 1, account_id: 2 } : {};
      records.push(
        ...auditRecordsOf(pickUser(), question, tools, time, redacted, answer),
      );
      n += 1;
    }
  }
  return records;
};

let auditRecords = seedAudit();

// 작업 ID → 그 작업을 낳은 질문의 ID (실제로는 승인 테이블에 저장된다). 결정·실행 행도 같은 질문 ID를 남긴다
const actionRequests = new Map<string, string>();

// 변경 작업의 사건 하나 (services/llm/audit.py의 action_event와 같은 모양)
const actionAuditRecord = (
  action: PendingAction,
  event: "requested" | "approved" | "denied" | "executed",
  offsetMs: number,
): AuditRecord => {
  const time = new Date(Date.now() + offsetMs);
  return {
    userId: MOCK_USER_ID,
    email: "demo@example.com",
    source: "web",
    requestId: actionRequests.get(action.actionId),
    at: auditAt(time, `action#${action.actionId}#${event}`),
    day: time.toISOString().slice(0, 10),
    kind: "action",
    locus: event === "requested" ? "egress" : "effect",
    event,
    actionId: action.actionId,
    tool: action.tool,
    input: action.args,
    summary: action.summary,
    status: "ok",
    ...(event !== "requested" && { decidedBy: MOCK_USER_ID }),
    ...(event === "requested" && action.taintedBy?.length && { taintedBy: action.taintedBy }),
    ...(event === "executed" && action.result && { result: action.result }),
    ...(event === "executed" &&
      action.cloudtrail && {
        awsRequestId: action.cloudtrail.request_id,
        cloudTrailEvent: `${action.cloudtrail.event_source}:${action.cloudtrail.event_name}`,
      }),
  };
};

// ---------------------------------------------------------------- 사용자 관리 (/users, services/llm/user_admin.py)
// 서버와 같은 규칙: 권한 세 단계(일반 사용자 · 결정자 · 관리자), 자기 권한 바꾸기·자기 정지 금지, 마지막 관리자 보호,
// 바꾼 내용은 감사 로그('사용자 관리')에 남는다. mock 사용자(demo)는 관리자다

const MANAGED_GROUPS: ManagedGroup[] = ["admins", "approvers"];
const ROLE_GROUPS: Record<UserRole, ManagedGroup[]> = { member: [], decider: ["approvers"], admin: ["admins", "approvers"] };
const roleOfGroups = (groups: ManagedGroup[]): UserRole =>
  groups.includes("admins") ? "admin" : groups.includes("approvers") ? "decider" : "member";
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const mockUser = (u: Omit<ManagedUser, "role">): ManagedUser => ({ ...u, role: roleOfGroups(u.groups) });
let mockUsers: ManagedUser[] = [
  mockUser({ username: MOCK_USER_ID, email: "demo@example.com", name: "Demo", status: "CONFIRMED", enabled: true,
    createdAt: daysAgo(40), groups: ["admins", "approvers"], isSelf: true }),
  mockUser({ username: "7c1e9a52-kim", email: "kim@example.com", status: "CONFIRMED", enabled: true,
    createdAt: daysAgo(21), groups: ["approvers"], isSelf: false }),
  mockUser({ username: "5b2d0c11-lee", email: "lee@example.com", status: "CONFIRMED", enabled: true,
    createdAt: daysAgo(9), groups: [], isSelf: false }),
  mockUser({ username: "e40f7a93-park", email: "park@example.com", status: "FORCE_CHANGE_PASSWORD", enabled: true,
    createdAt: daysAgo(1), groups: [], isSelf: false }),
  mockUser({ username: "90aa1d27-choi", email: "choi@example.com", status: "CONFIRMED", enabled: false,
    createdAt: daysAgo(60), groups: [], isSelf: false }),
];

const adminAuditRecord = (event: AdminEvent, target: ManagedUser, roles?: { fromRole: UserRole; toRole: UserRole }): AuditRecord => {
  const time = new Date();
  return {
    userId: MOCK_USER_ID, email: "demo@example.com", source: "web",
    at: auditAt(time, `admin#${newId().slice(0, 12)}#${event}`), day: time.toISOString().slice(0, 10),
    kind: "admin", event, status: "ok", decidedBy: MOCK_USER_ID,
    targetUser: target.username, ...(target.email && { targetEmail: target.email }), ...roles,
  };
};

const usersRoute = (method: string, parts: string[], body: RequestBody, params: Record<string, string>): Result => {
  if (!mockIsAdmin()) return [403, { error: "사용자 관리는 관리자(admins 그룹)만 할 수 있습니다" }];
  if (parts.length === 1 && method === "get") {
    const q = (params.q ?? "").toLowerCase();
    return [200, { users: mockUsers.filter((u) => (u.email ?? "").toLowerCase().startsWith(q)), cursor: null,
                   groups: MANAGED_GROUPS }];
  }
  if (parts.length === 1 && method === "post") {
    const email = (body.email ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return [400, { error: "올바른 이메일 주소가 아닙니다" }];
    if (mockUsers.some((u) => u.email === email)) return [409, { error: "이미 있는 사용자입니다" }];
    const created = mockUser({ username: newId(), email, status: "FORCE_CHANGE_PASSWORD", enabled: true,
                               createdAt: now(), groups: [], isSelf: false });
    mockUsers = [created, ...mockUsers];
    auditRecords = [adminAuditRecord("invited", created), ...auditRecords];
    return [200, created];
  }
  const user = mockUsers.find((u) => u.username === decodeURIComponent(parts[1] ?? ""));
  if (!user) return [404, { error: "사용자를 찾을 수 없습니다" }];
  const enabledAdmins = mockUsers.filter((u) => u.enabled && u.role === "admin");
  const update = (changed: ManagedUser, record: AuditRecord): Result => {
    mockUsers = mockUsers.map((u) => (u.username === changed.username ? changed : u));
    auditRecords = [record, ...auditRecords];
    return [200, changed];
  };
  if (parts.length === 3 && parts[2] === "role" && method === "put") {
    const role = body.role as UserRole;
    if (!(role in ROLE_GROUPS)) return [400, { error: "권한은 member, decider, admin 중 하나여야 합니다" }];
    if (role === user.role) return [200, user];
    if (user.role === "admin") {
      if (user.isSelf) return [409, { error: "자기 관리자 권한은 내릴 수 없습니다 (다른 관리자에게 부탁하세요)" }];
      if (enabledAdmins.length <= 1 && enabledAdmins.includes(user))
        return [409, { error: "마지막 관리자는 내릴 수 없습니다. 다른 관리자를 먼저 지정하세요" }];
    }
    const changed = { ...user, groups: ROLE_GROUPS[role], role };
    return update(changed, adminAuditRecord("role_changed", changed, { fromRole: user.role, toRole: role }));
  }
  if (parts.length === 3 && (parts[2] === "disable" || parts[2] === "enable") && method === "post") {
    const enabled = parts[2] === "enable";
    if (!enabled && user.isSelf) return [409, { error: "자기 계정은 정지할 수 없습니다" }];
    if (!enabled && enabledAdmins.length <= 1 && enabledAdmins.includes(user))
      return [409, { error: "마지막 관리자는 정지할 수 없습니다. 다른 관리자를 먼저 지정하세요" }];
    const changed = { ...user, enabled };
    return update(changed, adminAuditRecord(enabled ? "enabled" : "disabled", changed));
  }
  return [404, { error: "없는 경로입니다" }];
};

// 답변 전체 (GET /audit?answer=<질문 행의 at>&user=…, services/llm/audit.py query_answer)
const answerAudit = (at: string): Result => {
  const answer = auditAnswers.get(at.replace("#request#", "#answer#"));
  return answer === undefined
    ? [404, { error: "이 질문의 답변 기록이 없습니다" }]
    : [200, { answer, answerChars: answer.length }];
};

// 역추적 (GET /audit?trace=<actionId>, services/llm/audit_trace.py의 build와 같은 물음·같은 답)
const traceAudit = (actionId: string): Result => {
  if (!mockIsAdmin()) {
    return [403, { error: "감사 로그는 관리자(admins 그룹)만 볼 수 있습니다" }];
  }
  const byTime = (a: AuditRecord, b: AuditRecord) => (a.at < b.at ? -1 : 1);
  const events = auditRecords.filter((r) => r.actionId === actionId).sort(byTime);
  if (!events.length) {
    return [404, { error: "이 작업의 감사 기록을 찾지 못했습니다 (날짜를 확인하세요)" }];
  }
  const find = (event: string) => events.find((r) => r.event === event);
  const requested = find("requested");
  const approved = find("approved");
  const denied = find("denied");
  const finished = find("executed");
  const rows = requested?.requestId
    ? auditRecords.filter((r) => r.requestId === requested.requestId && r.kind !== "action").sort(byTime)
    : [];
  const question = rows.find((r) => r.kind === "request")?.question ?? null;
  const ingress = rows.filter((r) => r.kind === "tool" && (r.locus ?? "ingress") === "ingress");
  const suspicious = ingress.filter((r) => Array.isArray(r.injectionSuspected) && r.injectionSuspected.length);
  const tainted = requested?.taintedBy ?? [];
  const who = (r?: AuditRecord) => r?.email ?? r?.decidedBy ?? "알 수 없음";
  const at = (...records: (AuditRecord | undefined)[]) =>
    records.filter((r): r is AuditRecord => !!r).map((r) => r.at);
  const distance = (n: number) => (n <= 1 ? "바로 다음 호출" : `${n}번째 뒤 호출`);

  const steps: TraceStep[] = [
    finished
      ? { layer: "effect", question: "실행됐는가? 사람이 승인했는가?", status: "ok",
          answer: `사람이 승인해 실행했습니다 (승인: ${who(approved)})`, evidence: at(approved, finished) }
      : denied
        ? { layer: "effect", question: "실행됐는가? 사람이 승인했는가?", status: "ok",
            answer: `거절해 실행하지 않았습니다 (거절: ${who(denied)})`, evidence: at(denied) }
        : { layer: "effect", question: "실행됐는가? 사람이 승인했는가?", status: "ok",
            answer: "결정하지 않아(만료 포함) 실행하지 않았습니다", evidence: [] },
    { layer: "egress", question: "게이트를 거친 승인 요청 기록이 있는가?", status: requested ? "ok" : "fail",
      answer: requested ? `승인 요청이 있습니다: ${requested.summary}` : "이 작업의 승인 요청 기록을 찾지 못했습니다",
      evidence: at(requested) },
    tainted.length
      ? { layer: "residence", question: "요청 전에 의심 문구가 든 결과를 읽었는가?", status: "warn",
          answer: `예: ${tainted.map((t) => `${t.tool} 결과 뒤 ${distance(t.callsAgo)}`).join(", ")}에서 이 변경을 요청했습니다`,
          evidence: at(requested) }
      : { layer: "residence", question: "요청 전에 의심 문구가 든 결과를 읽었는가?", status: "ok", answer: "아니오", evidence: [] },
    tainted.length && requested
      ? { layer: "deliberation", question: "모델이 도구 결과 속 지시를 따랐을 가능성이 있는가?", status: "warn",
          answer: `유입·체류·유출이 함께 성립합니다: 의심 결과를 읽은 뒤 변경을 요청했습니다.${question ? ` 사용자의 질문("${question}")이 이 변경을 원했는지 비교하세요` : ""}`,
          evidence: [...suspicious.map((r) => r.at), requested.at] }
      : { layer: "deliberation", question: "모델이 도구 결과 속 지시를 따랐을 가능성이 있는가?", status: "ok",
          answer: "성립하지 않습니다", evidence: [] },
    suspicious.length
      ? { layer: "ingress", question: "이 질문에서 읽은 결과는 무엇이고, 의심 문구가 있었나?", status: "warn",
          answer: `도구 결과 ${ingress.length}건 중 ${suspicious.length}건에 의심 문구가 있었습니다`,
          evidence: suspicious.map((r) => r.at) }
      : { layer: "ingress", question: "이 질문에서 읽은 결과는 무엇이고, 의심 문구가 있었나?", status: "ok",
          answer: `도구 결과 ${ingress.length}건, 의심 문구 없음`, evidence: ingress.map((r) => r.at) },
    { layer: "interface", question: "등록부에 없는 도구를 불렀나?", status: "ok", answer: "아니오", evidence: [] },
    finished?.awsRequestId
      ? { layer: "mediation", question: "AWS 쪽 기록(CloudTrail)과 맞는가?", status: "info",
          answer: `앱에서는 확인할 수 없습니다. CloudTrail에서 요청 ID ${finished.awsRequestId}(${finished.cloudTrailEvent}) 이벤트를 찾고, 같은 시간대에 MCP 역할이 만든 다른 변경 이벤트가 없는지 대조하세요`,
          evidence: at(finished) }
      : { layer: "mediation", question: "AWS 쪽 기록(CloudTrail)과 맞는가?", status: "info",
          answer: "실행 기록이 없어 대조할 요청 ID가 없습니다. 같은 시간대에 MCP 역할이 만든 변경 이벤트가 없는지 CloudTrail에서 확인할 수 있습니다",
          evidence: [] },
  ];
  const verdict = steps.some((s) => s.status === "fail")
    ? "기록이 어긋납니다. 실패한 층부터 확인하세요"
    : steps.some((s) => s.status === "warn")
      ? "주의할 층이 있습니다. 경고가 붙은 층부터 확인하세요"
      : "모든 층이 정상입니다. 사용자가 요청하고 사람이 결정한 변경입니다";
  return [200, { actionId, steps, verdict, question, events, rows }];
};

const queryAudit = (query: AuditQuery): Result => {
  if (!mockIsAdmin()) {
    return [403, { error: "감사 로그는 관리자(admins 그룹)만 볼 수 있습니다" }];
  }
  const days = (value: string) => new Date(`${value}T00:00:00Z`).getTime();
  const to = query.to ?? new Date().toISOString().slice(0, 10);
  const from =
    query.from ?? new Date(days(to) - 6 * 86400000).toISOString().slice(0, 10);
  if ((days(to) - days(from)) / 86400000 + 1 > 31) {
    return [400, { error: "기간은 31일까지 조회할 수 있습니다" }];
  }
  const target =
    query.scope === "all" ? query.user : (query.user ?? MOCK_USER_ID);
  const matched = auditRecords
    .filter((r) => r.day >= from && r.day <= to)
    .filter((r) => !target || r.userId === target)
    .filter((r) => !query.tool || r.tool === query.tool)
    .filter((r) => !query.status || r.status === query.status)
    .filter((r) => !query.kind || r.kind === query.kind)
    // 체류층은 행이 따로 없다: 의심 결과를 읽은 뒤의 승인 요청 행 (services/llm/audit.py)
    .filter((r) =>
      !query.locus
        ? true
        : query.locus === "residence"
          ? !!r.taintedBy?.length
          : r.locus === query.locus,
    )
    .sort((a, b) => (a.at < b.at ? 1 : -1)); // 최신 기록부터
  const offset = Number(query.cursor ?? 0);
  const limit = Number(query.limit ?? 50);
  const items = matched.slice(offset, offset + limit);
  const next = offset + limit < matched.length ? String(offset + limit) : null;
  return [
    200,
    {
      items,
      cursor: next,
      scope: !target ? "all" : target === MOCK_USER_ID ? "mine" : "user",
      isAdmin: true,
      from,
      to,
    },
  ];
};

// 앱이 보내는 요청 본문 (세션 생성·제목 변경·메시지 저장)
interface RequestBody {
  title?: string;
  sender?: "user" | "assistant";
  text?: string;
  elapsed_time?: string;
  inference?: string;
  requestId?: string; // /llm1: 진행 상황을 찾을 열쇠
  actionId?: string; // /llm1: 승인한 변경 작업의 결과 설명
  question?: string; // /llm1: 질문
  email?: string; // POST /users: 초대할 이메일
  role?: string; // PUT /users/{username}/role: 새 권한
}

// 요청 본문은 axios가 JSON 문자열로 바꿔서 넘겨준다
const parseBody = (config: InternalAxiosRequestConfig): RequestBody => {
  if (!config.data) return {};
  if (typeof config.data === "string") {
    try {
      return JSON.parse(config.data);
    } catch {
      return {};
    }
  }
  return config.data;
};

// 전체 주소에서 API 경로만 남긴다. 'http://localhost:8000/sessions/1' · '/api/sessions/1' → '/sessions/1'
const apiPath = (config: InternalAxiosRequestConfig): string => {
  const url = new URL(config.url || "", "http://mock.local");
  return url.pathname.replace(/^\/api(?=\/)/, "");
};

// 목록·생성 응답에는 메시지를 빼고 보낸다 (백엔드와 같음)
const summary = ({
  sessionId,
  userId,
  title,
  createdAt,
  updatedAt,
}: MockSession) => ({
  sessionId,
  userId,
  title,
  createdAt,
  updatedAt,
});

type Result = [number, unknown];

const route = (
  method: string,
  path: string,
  body: RequestBody,
  params: Record<string, string> = {},
): Result => {
  const [, first, id, sub] = path.split("/"); // '/sessions/<id>/messages' → ['', 'sessions', id, 'messages']
  const session = id ? sessions.find((s) => s.sessionId === id) : undefined;

  if (method === "get" && path.startsWith("/llm1/progress/")) {
    const run = runs.get(path.split("/").pop() || "");
    if (!run) return [404, { error: "진행 상황이 없습니다." }];
    const elapsed = Date.now() - run.started;
    const steps = stepsAt(run, elapsed);
    const phase =
      elapsed >= run.total
        ? "done"
        : steps.some((step) => step.status === "running")
          ? "tool"
          : "thinking";
    return [200, { phase, steps, startedAt: run.started }];
  }
  if (method === "get" && path === "/audit" && params.trace) return traceAudit(params.trace);
  if (method === "get" && path === "/audit" && params.answer) return answerAudit(params.answer);
  if (first === "users") return usersRoute(method, path.split("/").filter(Boolean), body, params);
  if (method === "get" && path === "/audit") return queryAudit(params);
  if (method === "get" && path === "/health") {
    return [200, { status: "ok", model: MODEL }];
  }
  if (first === "sessions" && !id) {
    if (method === "get") return [200, { sessions: sessions.map(summary) }];
    if (method === "post") {
      const time = now();
      const created: MockSession = {
        sessionId: newId(),
        userId: "mock-user",
        title: body.title || "새 대화",
        createdAt: time,
        updatedAt: time,
        messages: [],
      };
      sessions.unshift(created);
      return [200, summary(created)];
    }
    if (method === "delete") {
      const deletedCount = sessions.length;
      sessions = [];
      return [200, { deletedCount }];
    }
  }
  if (first === "sessions" && id) {
    if (!session) return [404, { error: "Session not found" }];
    if (!sub) {
      if (method === "get") return [200, session];
      if (method === "put") {
        session.title = body.title || session.title;
        session.updatedAt = now();
        return [200, summary(session)];
      }
      if (method === "delete") {
        sessions = sessions.filter((s) => s !== session);
        return [200, { message: "Session deleted successfully" }];
      }
    }
    if (sub === "messages") {
      if (method === "get") return [200, { messages: session.messages }];
      if (method === "post") {
        const message: MockMessage = {
          id: newId(),
          sender: body.sender || "user",
          text: body.text || "",
          timestamp: now(),
          elapsed_time: body.elapsed_time,
          inference: body.inference,
        };
        session.messages.push(message);
        session.updatedAt = message.timestamp;
        return [200, message];
      }
      if (method === "delete") {
        session.messages = [];
        return [200, { message: "Messages deleted successfully" }];
      }
    }
  }
  if (path.startsWith("/actions/")) {
    const [, , actionId, decision] = path.split("/");
    const action = actions.get(actionId);
    if (!action) return [404, { error: "승인 요청을 찾을 수 없습니다" }];
    if (method === "get" && !decision) return [200, publicAction(action)];
    if (method === "post" && (decision === "approve" || decision === "deny")) {
      const current = publicAction(action);
      if (current.status === "expired")
        return [
          409,
          { error: "승인 시간(10분)이 지났습니다. 다시 요청해 주세요" },
        ];
      if (current.status !== "pending")
        return [
          409,
          { error: `이미 결정된 요청입니다 (상태: ${current.status})` },
        ];
      const decidedAt = Math.floor(Date.now() / 1000);
      Object.assign(action, { decidedBy: MOCK_USER_ID, decidedAt });
      const events: ("approved" | "denied" | "executed")[] = [];
      if (decision === "deny") {
        action.status = "denied";
        events.push("denied");
      } else {
        // 가짜 리소스를 바꾼다 (실제로는 MCP Lambda가 승인을 다시 확인하고 한 번만 실행한다)
        if (action.tool === "setLogRetention") mockResources.retention = 14;
        else mockResources.alarmActions = false;
        action.status = "executed";
        const cloudtrail = {
          event_source:
            action.tool === "setLogRetention"
              ? "logs.amazonaws.com"
              : "monitoring.amazonaws.com",
          event_name:
            action.tool === "setLogRetention"
              ? "PutRetentionPolicy"
              : "DisableAlarmActions",
          request_id: newId(),
        };
        action.result = JSON.stringify({
          status: "success",
          target: action.args.log_group_name ?? action.args.alarm_name,
          before: action.before,
          after: action.after,
          cloudtrail,
        });
        action.cloudtrail = cloudtrail;
        events.push("approved", "executed");
      }
      auditRecords = [
        ...events
          .map((event, index) => actionAuditRecord(action, event, index))
          .reverse(),
        ...auditRecords,
      ];
      return [200, action];
    }
  }
  if (method === "post" && path === "/llm1") {
    const run =
      (body.requestId && runs.get(body.requestId)) ||
      startRun(undefined, entryFor(body));
    const { answer, tools } = run.entry;
    // 이 질문과 도구 호출의 감사 기록 (실제 백엔드처럼 답이 끝난 뒤에 보인다). 승인 요청 행도 같은 질문 ID를 남긴다
    const questionRecords = auditRecordsOf(
      AUDIT_USERS[0],
      body.text || body.question || "질문",
      tools,
      new Date(run.started),
      {},
      answer,
    );
    // 변경 도구를 부른 답변이면 승인 요청을 만든다
    const pending: PendingAction[] = [];
    if (run.entry.approval) {
      const created = Math.floor(Date.now() / 1000);
      const action: PendingAction = {
        ...run.entry.approval(),
        actionId: newId(),
        status: "pending",
        requesterId: MOCK_USER_ID,
        createdAt: created,
        expiresAt: created + APPROVAL_TTL_S,
      };
      actions.set(action.actionId, action);
      if (questionRecords[0]?.requestId) actionRequests.set(action.actionId, questionRecords[0].requestId);
      pending.push(action);
      auditRecords = [
        actionAuditRecord(action, "requested", 0),
        ...auditRecords,
      ];
    }
    auditRecords = [...questionRecords, ...auditRecords];
    return [
      200,
      {
        answer,
        elapsed_time: `${Math.round(run.total / 1000)}초`,
        inference: JSON.parse(
          inferenceOf(tools, stepsAt(run, Infinity), pending, run.entry.artifacts),
        ),
      },
    ];
  }
  return [404, { error: `Route not found: ${method.toUpperCase()} ${path}` }];
};

const mockAdapter: AxiosAdapter = (config) =>
  new Promise((resolve, reject) => {
    const method = (config.method || "get").toLowerCase();
    const path = apiPath(config);
    const body = parseBody(config);
    // 질문이면 시간표를 만들고 마지막 단계가 끝난 뒤에 답한다
    const delay =
      method === "post" && path === "/llm1"
        ? startRun(body.requestId, entryFor(body)).total
        : 100;

    const timer = setTimeout(() => {
      const [status, data] = route(method, path, body, config.params ?? {});
      // 실제 서버처럼 JSON으로 한 번 바꿔서 넘긴다. 가짜 API가 들고 있는 배열을 그대로 넘기면
      // 앱이 받은 메시지 목록과 가짜 API의 목록이 같은 배열이 되어, 메시지를 저장할 때 두 번 들어간다
      const response: AxiosResponse = {
        data: JSON.parse(JSON.stringify(data)),
        status,
        statusText: String(status),
        headers: {},
        config,
      };
      // 실제 axios처럼 2xx가 아니면 오류로 넘긴다 (화면의 오류 처리도 확인할 수 있게)
      if (status >= 200 && status < 300) resolve(response);
      else
        reject(
          new axios.AxiosError(
            `Request failed with status code ${status}`,
            undefined,
            config,
            null,
            response,
          ),
        );
    }, delay);

    // 답변을 기다리는 중 '취소'를 누르면 실제 요청처럼 취소 오류로 끝낸다
    config.cancelToken?.promise.then((reason) => {
      clearTimeout(timer);
      reject(reason);
    });
  });

export function installMockApi(): void {
  axios.defaults.adapter = mockAdapter;
  console.info(
    "[mock] 백엔드 없이 가짜 API로 동작합니다. 대화 기록은 새로 고치면 처음으로 돌아갑니다.",
  );
}
