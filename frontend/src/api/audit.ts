// 감사 로그 조회 (GET /audit). 조건은 쿼리 문자열로 보낸다 (mock 모드는 config.params에서 읽는다)
import axios from 'axios';
import type { AuditPage, AuditQuery } from '@/types/audit';

export async function fetchAudit(query: AuditQuery): Promise<AuditPage> {
    // 비어 있는 조건은 보내지 않는다 (빈 글자로 보내면 서버가 그 값으로 거른다)
    const params = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''));
    const { data } = await axios.get<AuditPage>('/audit', { params });
    return data;
}
