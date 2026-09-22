import XCTest
@testable import WGAInstallerKit

/// 가짜 CLI: 실행 요청을 기록하고, 테스트가 이벤트·종료를 직접 보낸다
final class FakeLauncher: CLILaunching, @unchecked Sendable {
    final class Session: CLISession, @unchecked Sendable {
        var responses: [InstallerResponse] = []
        var cancelled = false
        func respond(_ response: InstallerResponse) { responses.append(response) }
        func cancel() { cancelled = true }
    }

    var launches: [(command: String, arguments: [String])] = []
    var sessions: [Session] = []
    var onEvent: (@Sendable (InstallerEvent) -> Void)?
    var onExit: (@Sendable (Int32) -> Void)?

    func launch(command: String, arguments: [String], onEvent: @escaping @Sendable (InstallerEvent) -> Void,
                onExit: @escaping @Sendable (Int32) -> Void) throws -> CLISession {
        launches.append((command, arguments))
        self.onEvent = onEvent
        self.onExit = onExit
        let session = Session()
        sessions.append(session)
        return session
    }
}

final class FakeHelper: CredentialHelping, @unchecked Sendable {
    var stored: [(String, String)] = []
    var failure: String?
    func store(accessKeyId: String, secretAccessKey: String) throws {
        if let failure { throw HelperError(message: failure) }
        stored.append((accessKeyId, secretAccessKey))
    }
    func status() throws -> HelperStatus {
        HelperStatus(stored: !stored.isEmpty, maskedAccessKeyId: stored.isEmpty ? nil : "AKIA************MPLE")
    }
    func delete() throws { stored.removeAll() }
}

final class MemoryStorage: SettingsStorage {
    var value: InstallerSettings?
    func load() -> InstallerSettings? { value }
    func save(_ settings: InstallerSettings) { value = settings }
}

@MainActor
final class WizardModelTests: XCTestCase {
    let accessKey = "AKIAIOSFODNN7EXAMPLE"
    let secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
    var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    func makeModel(_ launcher: FakeLauncher = FakeLauncher(), _ helper: FakeHelper = FakeHelper(),
                   storage: MemoryStorage = MemoryStorage()) -> WizardModel {
        WizardModel(launcher: launcher, helper: helper,
                    helperExecutable: URL(fileURLWithPath: "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper"),
                    awsDirectory: directory, storage: storage)
    }

    /// 메인 큐로 넘긴 이벤트 처리가 끝날 때까지 기다린다
    func drainMainQueue() async {
        await withCheckedContinuation { continuation in DispatchQueue.main.async { continuation.resume() } }
    }

    func testRunPassesSettingsAndTracksState() async {
        let launcher = FakeLauncher()
        let storage = MemoryStorage()
        var settings = InstallerSettings()
        settings.environment = "prod"
        settings.region = "us-west-2"
        settings.repositoryPath = "/Users/me/WGA_production"
        storage.value = settings
        let model = makeModel(launcher, storage: storage)

        model.run(.check)
        XCTAssertEqual(launcher.launches.first?.command, "check")
        XCTAssertEqual(launcher.launches.first?.arguments,
                       ["--env", "prod", "--region", "us-west-2", "--repo", "/Users/me/WGA_production"])
        XCTAssertEqual(model.status(of: .check), .running)
        XCTAssertTrue(model.isRunning(.check))

        model.run(.check)   // 실행 중에는 겹쳐 실행하지 않는다
        XCTAssertEqual(launcher.launches.count, 1)

        launcher.onEvent?(.check(id: "aws_cli", title: "AWS CLI", status: .ok, detail: "2.17", hint: nil, url: nil))
        launcher.onEvent?(.stepFinished(step: "check", status: .ok, summary: "통과"))
        launcher.onExit?(0)
        await drainMainQueue()
        XCTAssertEqual(model.status(of: .check), .ok)
        XCTAssertEqual(model.runs[.check]?.checks.map(\.id), ["aws_cli"])
        XCTAssertFalse(model.isRunning(.check))
    }

    func testRespondForwardsAndClearsPrompt() async {
        let launcher = FakeLauncher()
        let model = makeModel(launcher)
        model.run(.check)
        launcher.onEvent?(.confirmRequired(id: "put", command: "aws ...", reason: "저장"))
        await drainMainQueue()
        XCTAssertNotNil(model.runs[.check]?.pending)

        XCTAssertEqual(model.activePrompt?.id, "check/put")
        model.respond(.check, .confirm(id: "put", approved: true))
        XCTAssertNil(model.activePrompt)
        XCTAssertEqual(launcher.sessions.first?.responses, [.confirm(id: "put", approved: true)])
        XCTAssertNil(model.runs[.check]?.pending)
    }

    func testCancel() {
        let launcher = FakeLauncher()
        let model = makeModel(launcher)
        model.run(.check)
        model.cancel(.check)
        XCTAssertTrue(launcher.sessions.first?.cancelled == true)
    }

    func testInvalidKeyIsRejectedBeforeCallingHelper() async {
        let helper = FakeHelper()
        let model = makeModel(FakeLauncher(), helper)
        let saved = await model.saveAccessKey(accessKeyId: "ASIAIOSFODNN7EXAMPLE", secretAccessKey: secret)
        XCTAssertFalse(saved)
        XCTAssertTrue(helper.stored.isEmpty)
        XCTAssertTrue(model.awsMessage?.contains("임시 자격 증명") == true)
    }

    func testSavingKeyStoresConfiguresProfileAndChecks() async throws {
        let launcher = FakeLauncher()
        let helper = FakeHelper()
        let model = makeModel(launcher, helper)
        // 붙여 넣을 때 딸려 온 공백은 지운다
        let saved = await model.saveAccessKey(accessKeyId: " \(accessKey)\n", secretAccessKey: secret + " ")
        XCTAssertTrue(saved)

        XCTAssertEqual(helper.stored.map(\.0), [accessKey])
        XCTAssertEqual(helper.stored.map(\.1), [secret])
        XCTAssertEqual(model.settings.profile, "wga-installer")
        XCTAssertEqual(model.helperStatus?.stored, true)
        let config = try String(contentsOf: directory.appendingPathComponent("config"), encoding: .utf8)
        XCTAssertTrue(config.contains(#"credential_process = "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper" get"#))
        XCTAssertFalse(config.contains(secret))   // 비밀 값은 파일에 쓰지 않는다 (키체인에만)
        XCTAssertEqual(launcher.launches.last?.arguments, ["--env", "dev", "--profile", "wga-installer"])
        // 화면에 보여 줄 문구에도 비밀 값이 없다
        XCTAssertFalse(model.awsMessage?.contains(secret) == true)
    }

    func testHelperFailureIsShown() async {
        let helper = FakeHelper()
        helper.failure = "키체인이 잠겨 있습니다"
        let launcher = FakeLauncher()
        let model = makeModel(launcher, helper)
        let saved = await model.saveAccessKey(accessKeyId: accessKey, secretAccessKey: secret)
        XCTAssertFalse(saved)
        XCTAssertEqual(model.awsMessage, "키체인이 잠겨 있습니다")
        XCTAssertTrue(launcher.launches.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("config").path))
    }

    func testUseExistingProfile() {
        let launcher = FakeLauncher()
        let model = makeModel(launcher)
        model.useProfile("wga-dev")
        XCTAssertEqual(launcher.launches.last?.arguments, ["--env", "dev", "--profile", "wga-dev"])
    }

    func testSettingsArePersisted() {
        let storage = MemoryStorage()
        let model = makeModel(storage: storage)
        model.settings.environment = "prod"
        XCTAssertEqual(storage.value?.environment, "prod")
        XCTAssertEqual(makeModel(storage: storage).settings.environment, "prod")
    }

    func testLoadProfiles() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try "[default]\n[profile wga-dev]\n".write(to: directory.appendingPathComponent("config"), atomically: true,
                                                   encoding: .utf8)
        let model = makeModel()
        model.loadProfiles()
        XCTAssertEqual(model.profiles, ["default", "wga-dev"])
    }

    func testOnlyFirstTwoStepsAreAvailableInM4() {
        XCTAssertEqual(WizardStep.allCases.filter(\.isAvailable), [.check, .aws])
        XCTAssertEqual(WizardStep.aws.command, "check")
    }
}
