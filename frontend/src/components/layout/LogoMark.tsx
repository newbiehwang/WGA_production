import agentLogo from '@/assets/agent-logo.png';

// AXPI는 회사 로고 이미지를 썼다. WGA는 에이전트 아이콘과 서비스 이름을 쓴다
export function LogoMark({ showName = true }: { showName?: boolean }) {
    return (
        <div className="logo-mark">
            <img className="logo-image" src={agentLogo} alt="" />
            {showName ? <span className="logo-wordmark">MCP AIOps</span> : null}
        </div>
    );
}
