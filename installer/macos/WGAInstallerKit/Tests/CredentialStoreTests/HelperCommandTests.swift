import XCTest
@testable import CredentialStore

final class MemoryStore: SecretStore {
    var items: [String: AWSCredentials] = [:]
    var error: SecretStoreError?

    func save(_ credentials: AWSCredentials, account: String) throws {
        if let error { throw error }
        items[account] = credentials
    }
    func load(account: String) throws -> AWSCredentials? {
        if let error { throw error }
        return items[account]
    }
    func delete(account: String) throws { items[account] = nil }
    func status(account: String) throws -> StoredStatus {
        StoredStatus(stored: items[account] != nil, maskedAccessKeyId: items[account].map { CredentialFormat.masked($0.accessKeyId) })
    }
}

/// 헬퍼 명령 처리 (키체인 없이)
final class HelperCommandTests: XCTestCase {
    let valid = #"{"AccessKeyId": "AKIAIOSFODNN7EXAMPLE", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#

    func run(_ args: [String], stdin: String = "", store: SecretStore) -> HelperCommand.Output {
        HelperCommand.run(arguments: args, stdin: { Data(stdin.utf8) }, store: store)
    }

    func testStoreThenGetPrintsCredentialProcessFormat() throws {
        let store = MemoryStore()
        XCTAssertEqual(run(["store"], stdin: valid, store: store).exitCode, 0)
        let output = run(["get"], store: store)
        XCTAssertEqual(output.exitCode, 0)
        let json = try JSONSerialization.jsonObject(with: Data(output.stdout.utf8)) as! [String: Any]
        XCTAssertEqual(json["Version"] as? Int, 1)
        XCTAssertEqual(json["AccessKeyId"] as? String, "AKIAIOSFODNN7EXAMPLE")
        XCTAssertEqual(json["SecretAccessKey"] as? String, "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
        XCTAssertEqual(run([], store: store).stdout, output.stdout)   // 인자 없이 실행하면 get
    }

    func testGetWithoutStoredKeyFailsWithGuidance() {
        let output = run(["get"], store: MemoryStore())
        XCTAssertEqual(output.exitCode, 1)
        XCTAssertTrue(output.stderr.contains("AWS 연결"))
        XCTAssertEqual(output.stdout, "")   // AWS CLI가 잘못된 JSON을 받지 않도록 stdout은 비운다
    }

    func testMalformedInputIsNotEchoed() {
        let output = run(["store"], stdin: #"{"AccessKeyId": "AKIA", "SecretAccessKey": "sekrit-value"#, store: MemoryStore())
        XCTAssertEqual(output.exitCode, 1)
        XCTAssertFalse(output.stderr.contains("sekrit-value"))
    }

    func testInvalidFormatsAreRejected() {
        let store = MemoryStore()
        let temporary = #"{"AccessKeyId": "ASIAIOSFODNN7EXAMPLE", "SecretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"}"#
        XCTAssertTrue(run(["store"], stdin: temporary, store: store).stderr.contains("임시 자격 증명"))
        let shortSecret = #"{"AccessKeyId": "AKIAIOSFODNN7EXAMPLE", "SecretAccessKey": "short"}"#
        XCTAssertTrue(run(["store"], stdin: shortSecret, store: store).stderr.contains("Secret Access Key"))
        XCTAssertTrue(store.items.isEmpty)
    }

    func testStatusDoesNotRevealSecret() {
        let store = MemoryStore()
        _ = run(["store"], stdin: valid, store: store)
        let output = run(["status"], store: store)
        XCTAssertEqual(output.stdout, #"{"maskedAccessKeyId":"AKIA************MPLE","stored":true}"# + "\n")
    }

    func testDeleteAndUnknownCommand() {
        let store = MemoryStore()
        _ = run(["store"], stdin: valid, store: store)
        XCTAssertEqual(run(["delete"], store: store).exitCode, 0)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(run(["export"], store: store).exitCode, 2)
    }

    func testKeychainErrorsAreExplained() {
        let store = MemoryStore()
        store.error = .accessDenied
        XCTAssertTrue(run(["get"], store: store).stderr.contains("'키체인 접근' 앱에서"))
        store.error = .ownedByOtherProgram
        XCTAssertTrue(run(["store"], stdin: valid, store: store).stderr.contains("다른 버전의 헬퍼"))
    }

    func testMasking() {
        XCTAssertEqual(CredentialFormat.masked("AKIAIOSFODNN7EXAMPLE"), "AKIA************MPLE")
        XCTAssertEqual(CredentialFormat.masked("short"), "*****")
    }
}
