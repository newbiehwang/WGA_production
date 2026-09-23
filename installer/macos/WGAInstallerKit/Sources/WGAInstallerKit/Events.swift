import Foundation

// CLI(installer/core)와 주고받는 메시지 형식.
// 형식의 원본은 installer/core/wga_installer/events.py와 installer/core/README.md의 "앱과 주고받는 형식"이다.
// CLI는 stdout으로 한 줄에 JSON 하나(이벤트)를 쓰고, 앱은 stdin으로 한 줄에 JSON 하나(응답)를 쓴다.

/// 점검 항목(check 이벤트)의 상태
public enum CheckStatus: String, Decodable, Sendable {
    case ok, warn, fail, info
}

/// 단계 결과(step_finished 이벤트)의 상태
public enum StepOutcome: String, Decodable, Sendable {
    case ok, skipped, failed
}

public struct ChoiceOption: Decodable, Equatable, Sendable {
    public let id: String
    public let label: String
}

/// CLI가 보내는 이벤트 하나. 모르는 type은 `.unknown`으로 받아 앱이 멈추지 않게 한다
/// (CLI가 먼저 새 이벤트를 추가해도 오래된 앱이 계속 동작하도록).
public enum InstallerEvent: Equatable, Sendable {
    case stepStarted(step: String, title: String)
    case stepFinished(step: String, status: StepOutcome, summary: String)
    case check(id: String, title: String, status: CheckStatus, detail: String, hint: String?, url: String?)
    case log(stream: String, line: String)
    case progress(step: String, phase: String, label: String)
    case confirmRequired(id: String, command: String, reason: String)
    case inputRequired(id: String, prompt: String, secret: Bool)
    case choiceRequired(id: String, prompt: String, options: [ChoiceOption], defaultChoice: String)
    case dryRun(id: String, command: String, reason: String)
    case error(step: String, message: String, hint: String?)
    case unknown(type: String)
}

extension InstallerEvent: Decodable {
    private enum Keys: String, CodingKey {
        case type, step, title, status, summary, id, detail, hint, url, stream, line, phase, label
        case command, reason, prompt, secret, options, `default`, message
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        func s(_ key: Keys) throws -> String { try c.decode(String.self, forKey: key) }
        func o(_ key: Keys) throws -> String? { try c.decodeIfPresent(String.self, forKey: key) }
        switch type {
        case "step_started":
            self = .stepStarted(step: try s(.step), title: try s(.title))
        case "step_finished":
            self = .stepFinished(step: try s(.step), status: try c.decode(StepOutcome.self, forKey: .status),
                                 summary: try s(.summary))
        case "check":
            self = .check(id: try s(.id), title: try s(.title), status: try c.decode(CheckStatus.self, forKey: .status),
                          detail: try s(.detail), hint: try o(.hint), url: try o(.url))
        case "log":
            self = .log(stream: try s(.stream), line: try s(.line))
        case "progress":
            self = .progress(step: try s(.step), phase: try s(.phase), label: try s(.label))
        case "confirm_required":
            self = .confirmRequired(id: try s(.id), command: try s(.command), reason: try s(.reason))
        case "input_required":
            self = .inputRequired(id: try s(.id), prompt: try s(.prompt),
                                  secret: try c.decodeIfPresent(Bool.self, forKey: .secret) ?? true)
        case "choice_required":
            self = .choiceRequired(id: try s(.id), prompt: try s(.prompt),
                                   options: try c.decode([ChoiceOption].self, forKey: .options),
                                   defaultChoice: try s(.default))
        case "dry_run":
            self = .dryRun(id: try s(.id), command: try s(.command), reason: try s(.reason))
        case "error":
            self = .error(step: try s(.step), message: try s(.message), hint: try o(.hint))
        default:
            self = .unknown(type: type)
        }
    }

    /// stdout 한 줄을 이벤트로. JSON이 아니면 nil (CLI가 이벤트가 아닌 줄을 쓰는 일은 없지만, 깨진 줄로 앱이 멈추지 않게)
    public static func parse(line: String) -> InstallerEvent? {
        guard let data = line.data(using: .utf8), !line.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        return try? JSONDecoder().decode(InstallerEvent.self, from: data)
    }
}

/// 앱이 CLI의 질문(confirm_required·input_required·choice_required)에 보내는 답
public enum InstallerResponse: Equatable, Sendable {
    case confirm(id: String, approved: Bool)
    case secret(id: String, value: String)
    case text(id: String, value: String)
    case choice(id: String, choice: String)

    /// stdin에 쓸 한 줄 (끝의 줄바꿈 포함). 비밀 값은 이 문자열에만 들어가고 앱의 어떤 기록에도 남기지 않는다.
    public func jsonLine() -> String {
        let object: [String: Any]
        switch self {
        case let .confirm(id, approved): object = ["type": "confirm_response", "id": id, "approved": approved]
        case let .secret(id, value): object = ["type": "secret_response", "id": id, "value": value]
        case let .text(id, value): object = ["type": "text_response", "id": id, "value": value]
        case let .choice(id, choice): object = ["type": "choice_response", "id": id, "choice": choice]
        }
        // sortedKeys: 테스트에서 비교하기 쉽게 항상 같은 순서로 쓴다
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self) + "\n"
    }
}
