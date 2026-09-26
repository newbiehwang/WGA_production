// 감사 로그 조회 (GET /audit). 조건은 쿼리 문자열로 보낸다 (mock 모드는 config.params에서 읽는다)
import axios from 'axios';
import type { AuditAnswer, AuditPage, AuditQuery, AuditRecord, AuditTrace } from '@/types/audit';

export async function fetchAudit(query: AuditQuery): Promise<AuditPage> {
    // 비어 있는 조건은 보내지 않는다 (빈 글자로 보내면 서버가 그 값으로 거른다)
    const params = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
    const { data } = await axios.get<AuditPage>('/audit', { params });
    return data;
}

// 역추적 (GET /audit?trace=<actionId>&day=<YYYY-MM-DD>). day는 누른 행의 날짜: 서버가 그 앞뒤 하루에서 작업의 기록을 찾는다
export async function fetchTrace(actionId: string, day: string): Promise<AuditTrace> {
    const { data } = await axios.get<AuditTrace>('/audit', { params: { trace: actionId, day } });
    return data;
}

// 질문 하나의 답변 전체 (GET /audit?answer=<질문 행의 at>&user=<요청자>). 목록의 질문 행에는 앞부분만 온다.
// 답변을 남기기 전의 질문이거나 실패한 질문이면 404
export async function fetchAnswer(record: Pick<AuditRecord, 'at' | 'userId'>): Promise<AuditAnswer> {
    const { data } = await axios.get<AuditAnswer>('/audit', { params: { answer: record.at, user: record.userId } });
    return data;
}
