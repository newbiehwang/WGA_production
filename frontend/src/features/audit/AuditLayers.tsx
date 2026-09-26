// 층 다이어그램: 7계층(역추적과 같은 차례)을 위에서 아래로 쌓고, 이 기록이 있는 층을 파랗게, 이 기록이 남긴 흔적이 있는 층을
// 주황으로 짚는다. 도구 호출·변경 작업 행의 팝업창에서 항목 표 아래에 보인다 (질문·사용자 관리 행에는 층이 없다).
//
//   층  7계층에서 이 기록의 자리
//   ① 효과   승인·거절·실행·실패. AWS가 실제로 바뀌었는가
//   ② 유출   변경 도구 로그 보존 기간 변경을 불렀습니다. 실행하지 않고 승인을 요청합니다   [이 기록]
//   ③ 체류   의심 결과를 읽은 뒤 요청한 변경입니다 (1건)                              [흔적]
//   ④ 판단   ┄ 모델 안이라 기록할 수 없다 ┄                                          (점선)
//   ⑤ 유입   …
//   ⑥ 경계   …
//   ⑦ 매개   ┄ CloudTrail 요청 ID 로 대조합니다 ┄                                    [흔적] (점선: 앱 밖)
//
// - 이 기록의 층: 행의 locus (도구 반복이 정한다: 등록부에 없으면 경계, 변경 도구면 유출, 나머지는 유입. 변경 작업은 요청이 유출, 결정·실행이 효과)
// - 흔적: 체류(승인 요청 행의 taintedBy), 유입(도구 행의 의심 문구), 매개(실행한 AWS API의 요청 ID)
// - 판단·매개는 기록할 수 없거나 앱 밖이라 점선으로 그린다
import type { AuditRecord, TraceLayer } from '@/types/audit';
import { LAYERS, toolLabelOf } from './auditModel';

// 이 기록이 그 층에서 한 일 (그 층의 일반 설명 대신 보인다)
function hereText(record: AuditRecord): string {
    const tool = toolLabelOf(record.tool);
    if (record.kind === 'tool') {
        if (record.locus === 'interface') return `등록부에 없는 도구 ${tool}을(를) 불렀습니다. 변경 도구로 다뤄 승인을 요청합니다`;
        if (record.locus === 'egress') return `변경 도구 ${tool}을(를) 불렀습니다. 실행하지 않고 승인을 요청합니다`;
        return `${tool}의 결과가 모델에게 들어갔습니다`;
    }
    switch (record.event) {
        case 'requested':
            return '승인 요청을 만들었습니다. 아직 AWS는 바뀌지 않았습니다';
        case 'approved':
            return '사람이 승인했습니다';
        case 'denied':
            return '사람이 거절했습니다. AWS는 바뀌지 않았습니다';
        case 'executed':
            return '실행했습니다. AWS가 바뀌었습니다';
        case 'failed':
            return '실행하다 실패했습니다';
        default:
            return '';
    }
}

// 이 기록이 다른 층에 남긴 흔적
function marksOf(record: AuditRecord): Partial<Record<TraceLayer, string>> {
    const marks: Partial<Record<TraceLayer, string>> = {};
    if (record.taintedBy?.length)
        marks.residence = `의심 문구가 든 결과를 읽은 뒤 요청한 변경입니다 (${record.taintedBy.length}건)`;
    if (Array.isArray(record.injectionSuspected) && record.injectionSuspected.length)
        marks.ingress = `결과에 지시문처럼 보이는 문구가 있었습니다 (${record.injectionSuspected.join(', ')})`;
    if (record.awsRequestId) marks.mediation = `CloudTrail 요청 ID ${record.awsRequestId}로 대조합니다`;
    return marks;
}

export function AuditLayers({ record }: { record: AuditRecord }) {
    const marks = marksOf(record);
    return (
        <section className="audit-layers" aria-labelledby="audit-layers-title">
            <h4 id="audit-layers-title" className="audit-layers-title">
                층 <span className="audit-muted">7계층에서 이 기록의 자리</span>
            </h4>
            <ol className="audit-layer-stack">
                {LAYERS.map((layer, index) => {
                    const here = layer.id === record.locus;
                    // 이 기록의 층에 흔적이 겹치면(유입 행의 의심 문구) 이 기록 표시가 먼저다
                    const mark = marks[layer.id];
                    const offRecord = layer.recorded === 'none' || layer.recorded === 'outside';
                    return (
                        <li
                            key={layer.id}
                            className={`audit-layer${here ? ' is-here' : mark ? ' is-marked' : ''}${
                                offRecord ? ' is-off-record' : ''
                            }`}
                            aria-current={here ? 'true' : undefined}
                        >
                            <span className="audit-layer-no" aria-hidden="true">
                                {index + 1}
                            </span>
                            <span className="audit-layer-name">{layer.label}</span>
                            <span className="audit-layer-text">
                                <span className="audit-layer-desc">{here ? hereText(record) : layer.description}</span>
                                {mark ? <span className="audit-layer-mark">{mark}</span> : null}
                            </span>
                            {here ? (
                                <span className="audit-layer-tag">이 기록</span>
                            ) : mark ? (
                                <span className="audit-layer-tag is-mark">흔적</span>
                            ) : null}
                        </li>
                    );
                })}
            </ol>
            <p className="audit-layers-legend">
                <span className="audit-layers-key is-off-record" aria-hidden="true" /> 점선: 기록으로 남지 않는 층 (판단은
                모델 안, 매개는 앱 밖의 AWS 기록)
            </p>
        </section>
    );
}
