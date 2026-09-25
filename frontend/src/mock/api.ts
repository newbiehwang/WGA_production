// 백엔드 없이 화면만 띄우는 mock 모드의 가짜 API (`npm run dev:mock`).
//
// axios의 adapter(실제로 요청을 보내는 부분)를 바꿔 끼워, 앱이 부르는 API를 브라우저 안에서 대신 응답한다.
// 스토어·화면 코드는 그대로 두고 요청 한 곳만 가로채므로, 화면을 고칠 때 실제 배포와 같은 흐름으로 동작한다.
// - 대화 기록은 메모리에만 둔다. 새로 고치면 처음 예시 대화로 돌아간다.
// - 응답 모양은 백엔드(services/chat-history, services/llm)가 돌려주는 것과 맞춘다.
// - main.ts가 mock 모드일 때만 동적으로 불러오므로 배포용 빌드(npm run build)에는 들어가지 않는다.
import axios from "axios";
import type {
  AxiosAdapter,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";

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
const TOOL_MS = 1400; // 도구 하나가 도는 시간
const STEP_GAP_MS = 400; // 단계 사이

const MODELS = [
  {
    id: "claude-sonnet-5",
    display_name: "Claude Sonnet 5",
    created_at: "2026-06-01T00:00:00Z",
  },
  {
    id: "claude-opus-5",
    display_name: "Claude Opus 5",
    created_at: "2026-05-01T00:00:00Z",
  },
  {
    id: "claude-haiku-4-5",
    display_name: "Claude Haiku 4.5",
    created_at: "2025-10-01T00:00:00Z",
  },
];

interface MockTool {
  tool_name: string;
  input: Record<string, unknown>;
  status: "ok" | "error";
  error?: string;
}

// 답변 예시. 보낼 때마다 차례로 돌아가며, 화면에서 자주 고치는 요소(사고 요약·도구 목록·표·목록·코드·실패한 도구)를 모두 담았다.
// thinking: 도구를 부르기 전과 뒤의 사고 요약
const ANSWERS: { answer: string; tools: MockTool[]; thinking: string[] }[] = [
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

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const inferenceOf = (tools: object[], steps: object[] = []) =>
  JSON.stringify({
    tools_used: tools,
    steps, // 사고 요약과 도구 호출을 순서대로 (services/llm/llm_progress.py와 같은 모양)
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
  entry: (typeof ANSWERS)[number];
}

const runs = new Map<string, Run>();

const planRun = (entry: (typeof ANSWERS)[number]): Omit<Run, "started"> => {
  const plan: PlannedStep[] = [];
  let at = FIRST_THINKING_AT;
  plan.push({ at, step: { type: "thinking", text: entry.thinking[0] } });
  at += STEP_GAP_MS;
  for (const tool of entry.tools) {
    plan.push({
      at,
      until: at + TOOL_MS,
      step: {
        type: "tool",
        id: newId(),
        name: tool.tool_name,
        input: tool.input,
        status: tool.status,
        ...(tool.error && { error: tool.error }),
        ms: TOOL_MS,
      },
    });
    at += TOOL_MS + STEP_GAP_MS;
  }
  if (entry.thinking[1]) {
    plan.push({ at, step: { type: "thinking", text: entry.thinking[1] } });
    at += STEP_GAP_MS * 2;
  }
  return { plan, total: at + STEP_GAP_MS, entry };
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

const startRun = (requestId?: string): Run => {
  const entry = ANSWERS[answerIndex++ % ANSWERS.length];
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

// 앱이 보내는 요청 본문 (세션 생성·제목 변경·메시지 저장)
interface RequestBody {
  title?: string;
  sender?: "user" | "assistant";
  text?: string;
  elapsed_time?: string;
  inference?: string;
  requestId?: string; // /llm1: 진행 상황을 찾을 열쇠
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

const route = (method: string, path: string, body: RequestBody): Result => {
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
  if (method === "get" && path === "/health") {
    return [200, { status: "ok", models: MODELS, default_model: MODELS[0] }];
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
  if (method === "post" && path === "/llm1") {
    const run = (body.requestId && runs.get(body.requestId)) || startRun();
    const { answer, tools } = run.entry;
    return [
      200,
      {
        answer,
        elapsed_time: `${Math.round(run.total / 1000)}초`,
        inference: JSON.parse(inferenceOf(tools, stepsAt(run, Infinity))),
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
        ? startRun(body.requestId).total
        : 100;

    const timer = setTimeout(() => {
      const [status, data] = route(method, path, body);
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
