// 기간 안의 감사 기록을 모두 받아 온다 (GET /audit를 cursor로 이어 부른다).
// 왼쪽 거르기의 건수·검색·목록은 모두 받아 온 기록으로 브라우저에서 계산한다 (서버는 세어 주지 않는다).
// - 한 번에 PAGE_SIZE건씩, 모두 MAX_RECORDS건까지. 넘으면 최근 것만 쓰고 truncated로 알린다
// - 서버는 한 번의 조회에서 DynamoDB를 몇 쪽까지만 읽고 cursor를 돌려주므로(services/llm/audit.py MAX_PAGES),
//   받은 건수가 적어도 cursor가 있으면 이어 부른다. 끝없이 돌지 않게 MAX_CALLS에서 멈춘다
// - 기간을 빠르게 바꾸면 앞 조회의 응답이 늦게 올 수 있다. 마지막 조회의 응답만 쓴다
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAudit } from '@/api/audit';
import type { AuditRecord } from '@/types/audit';

const PAGE_SIZE = 200; // 서버의 MAX_LIMIT
export const MAX_RECORDS = 2000;
const MAX_CALLS = 40;

export interface AuditRange {
    from: string; // YYYY-MM-DD (UTC)
    to: string;
}

const errorText = (error: unknown) => {
    const response = (error as { response?: { status?: number; data?: { error?: string } } })?.response;
    if (response?.data?.error) return response.data.error;
    if (response?.status === 403) return '이 기록을 볼 권한이 없습니다.';
    return '감사 로그를 불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
};

export function useAuditRecords({ from, to }: AuditRange) {
    const [records, setRecords] = useState<AuditRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [truncated, setTruncated] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestNo = useRef(0);

    const load = useCallback(async () => {
        const no = ++requestNo.current;
        setLoading(true);
        setError(null);
        try {
            const all: AuditRecord[] = [];
            let cursor: string | undefined;
            for (let call = 0; call < MAX_CALLS; call += 1) {
                const page = await fetchAudit({ from, to, scope: 'all', limit: PAGE_SIZE, cursor });
                if (no !== requestNo.current) return;
                all.push(...page.items);
                cursor = page.cursor ?? undefined;
                if (!cursor || all.length >= MAX_RECORDS) break;
            }
            setRecords(all.slice(0, MAX_RECORDS));
            setTruncated(!!cursor); // 다 읽지 못하고 멈췄다 (건수 한도 또는 호출 한도)
        } catch (err) {
            if (no !== requestNo.current) return;
            setError(errorText(err));
            setRecords([]);
            setTruncated(false);
        } finally {
            if (no === requestNo.current) setLoading(false);
        }
    }, [from, to]);

    useEffect(() => {
        load();
    }, [load]);

    return { records, loading, truncated, error, reload: load };
}
