import CredentialStore
import Foundation

/// 마법사의 단계 (계획서 5.1절의 화면 흐름)
public enum WizardStep: String, CaseIterable, Identifiable, Sendable {
    case check, aws, setup, deploy, verify, oidc, teardown

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .check: return "시작 · 사전 점검"
        case .aws: return "AWS 연결"
        case .setup: return "사전 설정"
        case .deploy: return "배포"
        case .verify: return "검증"
        case .oidc: return "GitHub 자동 배포"
        case .teardown: return "정리"
        }
    }

    /// 이 화면이 실행하는 CLI 명령. AWS 연결 화면은 자격 증명을 바꾼 뒤 check로 누구로 접속되는지 확인한다.
    public var command: String {
        switch self {
        case .aws: return "check"
        default: return rawValue
        }
    }

    /// M4에서 화면이 있는 단계 (나머지는 M5에서 추가)
    public var isAvailable: Bool { self == .check || self == .aws }
}

/// 설정 화면에서 바꾸는 값. 모든 CLI 명령에 공통 옵션으로 넘긴다.
public struct InstallerSettings: Codable, Equatable, Sendable {
    public var environment: String = "dev"   // dev | test | prod
    public var region: String = ""           // 비우면 CLI 규칙(AWS_REGION → 프로필 → 서울)
    public var repositoryPath: String = ""   // WGA 저장소 폴더
    public var profile: String?              // 사용할 AWS CLI 프로필 (nil이면 AWS CLI 기본 규칙)

    public init() {}

    public var arguments: [String] {
        var args = ["--env", environment]
        if !region.isEmpty { args += ["--region", region] }
        if let profile, !profile.isEmpty { args += ["--profile", profile] }
        if !repositoryPath.isEmpty { args += ["--repo", repositoryPath] }
        return args
    }
}

/// 설정을 어디에 저장할지 (앱은 UserDefaults, 테스트는 메모리)
public protocol SettingsStorage {
    func load() -> InstallerSettings?
    func save(_ settings: InstallerSettings)
}

public final class UserDefaultsSettingsStorage: SettingsStorage {
    private let defaults: UserDefaults
    private let key = "installerSettings"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> InstallerSettings? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(InstallerSettings.self, from: $0) }
    }

    public func save(_ settings: InstallerSettings) {
        defaults.set(try? JSONEncoder().encode(settings), forKey: key)
    }
}

/// 화면 전체의 상태. SwiftUI 뷰는 이 객체를 보고 그리기만 한다.
@MainActor
public final class WizardModel: ObservableObject {
    @Published public var selected: WizardStep = .check
    @Published public var settings: InstallerSettings { didSet { storage.save(settings) } }
    @Published public private(set) var runs: [WizardStep: StepRun] = [:]
    @Published public private(set) var helperStatus: HelperStatus?
    @Published public private(set) var profiles: [String] = []
    @Published public var awsMessage: String?     // AWS 연결 화면의 안내·오류 문구

    private let launcher: CLILaunching
    private let helper: CredentialHelping
    private let helperExecutable: URL
    private let awsDirectory: URL
    private let storage: SettingsStorage
    private var sessions: [WizardStep: CLISession] = [:]

    public init(launcher: CLILaunching, helper: CredentialHelping, helperExecutable: URL,
                awsDirectory: URL = AWSConfigFile.defaultDirectory(), storage: SettingsStorage) {
        self.launcher = launcher
        self.helper = helper
        self.helperExecutable = helperExecutable
        self.awsDirectory = awsDirectory
        self.storage = storage
        self.settings = storage.load() ?? InstallerSettings()
    }

    public func status(of step: WizardStep) -> StepStatus {
        runs[step]?.status ?? .idle
    }

    public func isRunning(_ step: WizardStep) -> Bool {
        sessions[step] != nil
    }

    /// 지금 사용자에게 보여 줄 질문. CLI는 한 번에 질문 하나만 하고 답을 기다린다.
    public var activePrompt: PromptContext? {
        for step in WizardStep.allCases {
            if let prompt = runs[step]?.pending { return PromptContext(step: step, prompt: prompt) }
        }
        return nil
    }

    // MARK: - CLI 실행

    /// 단계의 CLI 명령을 실행한다. 이미 실행 중이면 무시한다 (같은 명령을 겹쳐 실행하지 않도록).
    public func run(_ step: WizardStep, extraArguments: [String] = []) {
        guard sessions[step] == nil else { return }
        runs[step] = StepRun(command: step.command)
        do {
            // 콜백은 백그라운드 스레드에서 온다. DispatchQueue.main으로 옮기면 받은 순서가 지켜진다
            // (이벤트 순서가 바뀌면 질문과 답이 어긋날 수 있다)
            sessions[step] = try launcher.launch(
                command: step.command, arguments: settings.arguments + extraArguments,
                onEvent: { [weak self] event in
                    DispatchQueue.main.async { MainActor.assumeIsolated { self?.runs[step]?.apply(event) } }
                },
                onExit: { [weak self] code in
                    DispatchQueue.main.async { MainActor.assumeIsolated { self?.finished(step, code) } }
                })
        } catch {
            runs[step]?.apply(.error(step: step.command, message: "설치 마법사 CLI를 실행하지 못했습니다: \(error)",
                                     hint: "앱 번들의 Resources/core 폴더가 있는지 확인하세요"))
            runs[step]?.finish(exitCode: 1)
        }
    }

    /// 질문에 답한다
    public func respond(_ step: WizardStep, _ response: InstallerResponse) {
        guard let session = sessions[step] else { return }
        session.respond(response)
        runs[step]?.answered(response.id)
    }

    /// 실행 중인 명령을 취소한다 (CLI에 SIGINT)
    public func cancel(_ step: WizardStep) {
        sessions[step]?.cancel()
    }

    private func finished(_ step: WizardStep, _ code: Int32) {
        sessions[step] = nil
        runs[step]?.finish(exitCode: code)
    }

    // MARK: - AWS 연결

    /// "기존 AWS 프로필 사용" 목록을 읽는다
    public func loadProfiles() {
        let config = (try? String(contentsOf: awsDirectory.appendingPathComponent("config"), encoding: .utf8)) ?? ""
        let credentials = (try? String(contentsOf: awsDirectory.appendingPathComponent("credentials"),
                                       encoding: .utf8)) ?? ""
        profiles = AWSConfigFile.profileNames(config: config, credentials: credentials)
    }

    /// 키체인에 저장된 키가 있는지 (값은 읽지 않는다)
    public func refreshHelperStatus() async {
        let helper = self.helper
        helperStatus = try? await Task.detached { try helper.status() }.value
    }

    /// 새 Access Key를 키체인에 저장하고, ~/.aws/config에 wga-installer 프로필을 만든 뒤 점검한다.
    /// 성공하면 true. 호출한 화면은 입력란을 비워야 한다 (값을 화면 상태에 남기지 않도록).
    @discardableResult
    public func saveAccessKey(accessKeyId: String, secretAccessKey: String) async -> Bool {
        let credentials = AWSCredentials(accessKeyId: accessKeyId.trimmingCharacters(in: .whitespacesAndNewlines),
                                         secretAccessKey: secretAccessKey.trimmingCharacters(in: .whitespacesAndNewlines))
        if let problem = CredentialFormat.validate(credentials) {
            awsMessage = problem
            return false
        }
        let helper = self.helper
        do {
            // 헬퍼 실행은 프로세스를 기다리므로 메인 스레드 밖에서 한다
            try await Task.detached {
                try helper.store(accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey)
            }.value
            let backup = try AWSConfigFile.writeInstallerProfile(
                helper: helperExecutable, region: settings.region.isEmpty ? "ap-northeast-2" : settings.region,
                directory: awsDirectory)
            awsMessage = "키체인에 저장하고 ~/.aws/config에 \(AWSConfigFile.profileName) 프로필을 만들었습니다"
                + (backup.map { " (원래 파일은 \($0.lastPathComponent)에 백업)" } ?? "")
        } catch {
            awsMessage = "\(error)"
            return false
        }
        settings.profile = AWSConfigFile.profileName
        await refreshHelperStatus()
        loadProfiles()
        run(.aws)
        return true
    }

    /// 이미 있는 AWS CLI 프로필을 쓴다 (예: wga-dev)
    public func useProfile(_ name: String?) {
        settings.profile = name
        awsMessage = nil
        run(.aws)
    }
}

/// 시트로 띄울 질문과 그 질문을 한 단계
public struct PromptContext: Identifiable, Equatable, Sendable {
    public let step: WizardStep
    public let prompt: PendingPrompt
    public var id: String { "\(step.rawValue)/\(prompt.id)" }
}

extension InstallerResponse {
    public var id: String {
        switch self {
        case let .confirm(id, _), let .secret(id, _), let .text(id, _), let .choice(id, _): return id
        }
    }
}
