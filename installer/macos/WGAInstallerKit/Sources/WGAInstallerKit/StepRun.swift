import Foundation

/// 마법사 사이드바의 단계 상태: 대기 → 진행 → 완료/건너뜀/실패
public enum StepStatus: Equatable, Sendable {
    case idle, running, ok, skipped, failed, cancelled
}

public struct CheckItem: Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var status: CheckStatus
    public var detail: String
    public var hint: String?
    public var url: String?
}

public struct LogLine: Identifiable, Equatable, Sendable {
    public let id: Int          // 받은 순서 (목록 표시용)
    public let stream: String   // stdout | stderr | info
    public let text: String
}

/// CLI 한 명령(예: setup)이 내보내는 하위 단계(quota, ssm_parameters ...)
public struct SubStep: Identifiable, Equatable, Sendable {
    public let id: String
    public var title: String
    public var status: StepStatus
    public var summary: String?
}

public struct ErrorItem: Equatable, Sendable {
    public let step: String
    public let message: String
    public let hint: String?
}

/// 앱이 사용자에게 물어봐야 하는 질문 (CLI의 confirm_required·input_required·choice_required)
public enum PendingPrompt: Equatable, Sendable {
    case confirm(id: String, command: String, reason: String)
    case input(id: String, prompt: String, secret: Bool)
    case choice(id: String, prompt: String, options: [ChoiceOption], defaultChoice: String)

    public var id: String {
        switch self {
        case let .confirm(id, _, _), let .input(id, _, _), let .choice(id, _, _, _): return id
        }
    }
}

/// CLI 명령 한 번 실행의 화면 상태. 이벤트를 차례로 적용(apply)해 만든다.
/// 뷰와 떼어 두어 이벤트 목록만으로 상태 전이를 테스트할 수 있다.
public struct StepRun: Equatable, Sendable {
    public static let maxLogLines = 5000   // 배포 로그는 수만 줄이 될 수 있어 최근 것만 화면에 둔다

    public let command: String
    public private(set) var status: StepStatus = .running
    public private(set) var title: String?
    public private(set) var summary: String?
    public private(set) var checks: [CheckItem] = []
    public private(set) var substeps: [SubStep] = []
    public private(set) var logs: [LogLine] = []
    public private(set) var progress: (phase: String, label: String)?
    public private(set) var errors: [ErrorItem] = []
    public private(set) var dryRuns: [(command: String, reason: String)] = []
    public private(set) var pending: PendingPrompt?
    public private(set) var exitCode: Int32?
    private var nextLogID = 0

    public init(command: String) {
        self.command = command
    }

    public mutating func apply(_ event: InstallerEvent) {
        switch event {
        case let .stepStarted(step, title):
            if step == command {
                self.title = title
            } else {
                upsertSubstep(step) { $0.title = title; $0.status = .running }
            }
        case let .stepFinished(step, outcome, summary):
            let status: StepStatus = outcome == .ok ? .ok : outcome == .skipped ? .skipped : .failed
            if step == command {
                // 최종 상태는 종료 코드로 정한다 (finish). 여기서는 요약만 받아 둔다
                self.summary = summary
                self.pendingOutcome = status
            } else {
                upsertSubstep(step) { $0.status = status; $0.summary = summary }
            }
        case let .check(id, title, status, detail, hint, url):
            let item = CheckItem(id: id, title: title, status: status, detail: detail, hint: hint, url: url)
            if let index = checks.firstIndex(where: { $0.id == id }) { checks[index] = item } else { checks.append(item) }
        case let .log(stream, line):
            appendLog(stream: stream, text: line)
        case let .progress(_, phase, label):
            progress = (phase, label)
        case let .confirmRequired(id, command, reason):
            pending = .confirm(id: id, command: command, reason: reason)
        case let .inputRequired(id, prompt, secret):
            pending = .input(id: id, prompt: prompt, secret: secret)
        case let .choiceRequired(id, prompt, options, defaultChoice):
            pending = .choice(id: id, prompt: prompt, options: options, defaultChoice: defaultChoice)
        case let .dryRun(_, command, reason):
            dryRuns.append((command, reason))
        case let .error(step, message, hint):
            errors.append(ErrorItem(step: step, message: message, hint: hint))
        case .unknown:
            break   // 새 버전 CLI의 모르는 이벤트는 무시한다
        }
    }

    /// 질문에 답했다 (같은 질문을 두 번 답하지 않도록 지운다)
    public mutating func answered(_ id: String) {
        if pending?.id == id { pending = nil }
    }

    /// CLI가 끝났다. 종료 코드가 최종 판단이다: 0이면 step_finished의 상태(ok/skipped), 130은 취소, 그 밖은 실패.
    public mutating func finish(exitCode: Int32) {
        self.exitCode = exitCode
        pending = nil
        // 진행 중으로 남은 하위 단계는 끝나지 못한 것이다
        for index in substeps.indices where substeps[index].status == .running {
            substeps[index].status = exitCode == 130 ? .cancelled : .failed
        }
        switch exitCode {
        case 0: status = pendingOutcome ?? .ok
        case 130: status = .cancelled
        default: status = .failed
        }
        if exitCode == 3, errors.isEmpty {
            // 실행기가 쓸 수 있는 Python을 찾지 못했다 (installer/core/wga-installer)
            errors.append(ErrorItem(step: "python", message: "Python 3.10 이상을 찾지 못했습니다",
                                    hint: "터미널에서 brew install python 을 실행하세요"))
        }
    }

    public static func == (lhs: StepRun, rhs: StepRun) -> Bool {
        lhs.command == rhs.command && lhs.status == rhs.status && lhs.title == rhs.title && lhs.summary == rhs.summary
            && lhs.checks == rhs.checks && lhs.substeps == rhs.substeps && lhs.logs == rhs.logs
            && lhs.progress?.phase == rhs.progress?.phase && lhs.progress?.label == rhs.progress?.label
            && lhs.errors == rhs.errors && lhs.pending == rhs.pending && lhs.exitCode == rhs.exitCode
            && lhs.dryRuns.map(\.command) == rhs.dryRuns.map(\.command)
    }

    private var pendingOutcome: StepStatus?

    private mutating func upsertSubstep(_ id: String, _ change: (inout SubStep) -> Void) {
        if let index = substeps.firstIndex(where: { $0.id == id }) {
            change(&substeps[index])
        } else {
            var item = SubStep(id: id, title: id, status: .running, summary: nil)
            change(&item)
            substeps.append(item)
        }
    }

    private mutating func appendLog(stream: String, text: String) {
        logs.append(LogLine(id: nextLogID, stream: stream, text: text))
        nextLogID += 1
        if logs.count > Self.maxLogLines { logs.removeFirst(logs.count - Self.maxLogLines) }
    }
}
