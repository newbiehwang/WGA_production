// 답변을 만드는 과정 (Claude Code가 작업 과정을 보여 주는 모양을 따랐다).
//
// 답을 기다리는 동안 (LiveLine): 지금 단계만 한 줄로. 단계가 바뀌면 새 줄이 아래에서 올라오며 바뀐다
//   ✶ 로그 그룹 조회 중… (12초)
//
// 답이 온 뒤 (ProgressTrace): 답변 아래 '사고 과정'을 펼치면 전체 과정이 보인다
//   ▸ ✻ 생각  로그 그룹부터 찾아야 한다…          ← 사고 요약. 첫 줄만 보이고 누르면 펼쳐진다
//   ● 로그 그룹 조회  /aws/lambda · 5
//     ⎿ 1.2초                                      ← 도구 결과 (실패면 이유)
//   ● 도구 찾기  lookup_events
//     ⎿ CloudTrail 이벤트 조회                     ← 도구 검색: 모델이 필요한 도구를 찾아 불러왔다
//
// 기다리는 동안에는 진행 상황(GET /llm1/progress)으로, 답이 온 뒤에는 답변의 inference.steps로 단계를 읽는다.
import { useEffect, useState } from 'react';
import type { TraceStep } from '@/utils/toolTrace';

// Claude Code의 작업 중 표시와 같은 글자들을 차례로 돌린다
const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const SPINNER_MS = 120;

const prefersReducedMotion = () =>
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function Spinner() {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        if (prefersReducedMotion()) return; // 움직임을 줄이는 설정이면 멈춘 별표 하나
        const timer = window.setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), SPINNER_MS);
        return () => window.clearInterval(timer);
    }, []);
    return (
        <span className="trace-spinner" aria-hidden="true">
            {prefersReducedMotion() ? '✻' : SPINNER_FRAMES[frame]}
        </span>
    );
}

// 지난 시간 (1초마다 다시 그린다)
function useElapsedSeconds(since: string) {
    const started = new Date(since).getTime();
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, []);
    return Math.max(0, Math.floor((now - started) / 1000));
}

// 지금 단계의 이름 (세부 내용 없이). 도구를 실행 중이면 그 도구, 아니면 모델이 생각하는 중이다
function currentStep(steps: TraceStep[], phase: string): string {
    const running = [...steps].reverse().find((step) => step.kind === 'tool' && step.status === 'running');
    if (phase === 'tool' && running?.kind === 'tool') return `${running.label.replace(/ 요청$/, '')} 중`;
    return '생각하는 중';
}

// 답을 기다리는 동안의 한 줄: 도는 별표 · 지금 단계 · 지난 시간.
// 단계 글자가 바뀌면 key가 바뀌어 새로 그려지며, 아래에서 올라오는 전환 효과(trace-line-in)가 난다
export function LiveLine({ steps, phase, since }: { steps: TraceStep[]; phase: string; since: string }) {
    const seconds = useElapsedSeconds(since);
    const step = currentStep(steps, phase);
    return (
        <div className="trace trace-live" role="status" aria-live="polite">
            <Spinner />
            <span key={step} className="trace-verb trace-line-in">
                {step}…
            </span>
            <span className="trace-time">({seconds}초)</span>
        </div>
    );
}

function ThinkingStep({ step }: { step: Extract<TraceStep, { kind: 'thinking' }> }) {
    const [open, setOpen] = useState(false);
    return (
        <li className={`trace-step trace-thinking${open ? ' is-open' : ''}`}>
            <button type="button" className="trace-thinking-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                <span className="trace-caret" aria-hidden="true">
                    ▸
                </span>
                <span className="trace-thinking-mark" aria-hidden="true">
                    ✻
                </span>
                <span className="trace-thinking-title">생각</span>
                {open ? null : <span className="trace-thinking-preview">{step.preview}</span>}
            </button>
            {open ? <p className="trace-thinking-text">{step.text}</p> : null}
        </li>
    );
}

function ToolStepView({ step }: { step: Extract<TraceStep, { kind: 'tool' }> }) {
    // 실패는 색만이 아니라 글자('실패')로도 알린다
    const result =
        step.status === 'error'
            ? `실패${step.error ? `: ${step.error}` : ''}`
            : step.status === 'ok'
              ? (step.result ?? step.seconds)
              : null;
    return (
        <li className={`trace-step trace-tool is-${step.status}`} title={step.name}>
            <span className="trace-tool-line">
                <span className="trace-bullet" aria-hidden="true">
                    ●
                </span>
                <span className="trace-tool-label">{step.label}</span>
                {step.detail ? <span className="trace-tool-detail">{step.detail}</span> : null}
                {step.suspicious ? (
                    // 도구 결과(로그·문서 등 제3자가 쓴 글)에 모델에게 하는 지시처럼 보이는 문구가 있었다.
                    // 모델에는 데이터로만 다루라는 경고와 함께 넘겼고, 변경은 사람이 승인해야 실행된다
                    <span
                        className="trace-suspicious"
                        title="도구 결과에 지시문처럼 보이는 문구가 있어 데이터로만 다뤘습니다"
                    >
                        의심 문구
                    </span>
                ) : null}
                {step.status === 'running' ? <span className="sr-only">실행 중</span> : null}
            </span>
            {result ? (
                <span className="trace-tool-result">
                    <span aria-hidden="true">⎿ </span>
                    {result}
                </span>
            ) : null}
        </li>
    );
}

// 답변을 만든 전체 과정 (답변 아래 '사고 과정'을 펼치면)
export function ProgressTrace({ steps }: { steps: TraceStep[] }) {
    if (steps.length === 0) return null;
    return (
        <div className="trace">
            <ol className="trace-steps" aria-label="답변을 만든 과정">
                {steps.map((step, index) =>
                    step.kind === 'thinking' ? (
                        <ThinkingStep key={index} step={step} />
                    ) : (
                        <ToolStepView key={index} step={step} />
                    ),
                )}
            </ol>
        </div>
    );
}
