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

const RESPONSE_DELAY = 800; // LLM 응답을 기다리는 느낌을 내는 시간 (ms). 로딩 표시·취소 버튼도 확인할 수 있다

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

// 답변 예시. 보낼 때마다 차례로 돌아가며, 화면에서 자주 고치는 요소(도구 목록·표·목록·코드·실패한 도구)를 모두 담았다
const ANSWERS: { answer: string; tools: object[] }[] = [
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
        tool_name: "list_log_groups",
        input: { prefix: "/aws/lambda/wga-" },
        status: "ok",
      },
      {
        tool_name: "analyze_log_group",
        input: { log_group_name: "/aws/lambda/wga-llm-dev", days: 7 },
        status: "ok",
      },
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
        tool_name: "get_detailed_breakdown_by_day",
        input: { days: 30, group_by: "SERVICE" },
        status: "ok",
      },
    ],
  },
  {
    answer:
      "알람 목록을 가져오지 못했습니다. 권한을 확인한 뒤 다시 물어봐 주세요.",
    tools: [
      {
        tool_name: "get_cloudwatch_alarms_for_service",
        input: { service: "lambda" },
        status: "error",
        error:
          "AccessDeniedException: cloudwatch:DescribeAlarms 권한이 없습니다",
      },
    ],
  },
  {
    answer:
      "도구를 쓰지 않은 답변입니다. 짧은 문장만 있을 때 화면이 어떻게 보이는지 확인할 수 있습니다.",
    tools: [],
  },
];

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const inferenceOf = (tools: object[]) =>
  JSON.stringify({
    tools_used: tools,
    reasoning: [],
    session_cached: false,
    token_usage: {},
  });

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
          inference: inferenceOf(ANSWERS[0].tools),
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
    const { answer, tools } = ANSWERS[answerIndex++ % ANSWERS.length];
    return [
      200,
      {
        answer,
        elapsed_time: "1초",
        inference: JSON.parse(inferenceOf(tools)),
      },
    ];
  }
  return [404, { error: `Route not found: ${method.toUpperCase()} ${path}` }];
};

const mockAdapter: AxiosAdapter = (config) =>
  new Promise((resolve, reject) => {
    const method = (config.method || "get").toLowerCase();
    const path = apiPath(config);
    const delay = path === "/llm1" ? RESPONSE_DELAY : 100;

    const timer = setTimeout(() => {
      const [status, data] = route(method, path, parseBody(config));
      const response: AxiosResponse = {
        data,
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
