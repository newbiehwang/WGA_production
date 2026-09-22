import XCTest
@testable import WGAInstallerKit

/// ~/.aws/config 편집: 설치 마법사 프로필만 바꾸고 나머지는 그대로 둔다
final class AWSConfigFileTests: XCTestCase {
    let values = [("credential_process", "\"/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper\" get"),
                  ("region", "ap-northeast-2")]

    func testAddsSectionToEmptyFile() {
        XCTAssertEqual(AWSConfigFile.upsertProfile("", name: "wga-installer", values: values), """
        [profile wga-installer]
        credential_process = "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper" get
        region = ap-northeast-2

        """)
    }

    func testAppendsWithoutTouchingOtherSections() {
        let original = """
        # 내 설정
        [default]
        region = us-east-1

        [profile wga-dev]
        sso_session = my
        """
        let updated = AWSConfigFile.upsertProfile(original, name: "wga-installer", values: values)
        XCTAssertTrue(updated.hasPrefix(original + "\n\n[profile wga-installer]\n"))
    }

    func testReplacesOnlyItsOwnSection() {
        let original = """
        [default]
        region = us-east-1

        [profile wga-installer]
        credential_process = /old/path get
        region = us-west-2
        cli_pager =

        [profile other]
        region = eu-west-1

        """
        let updated = AWSConfigFile.upsertProfile(original, name: "wga-installer", values: values)
        XCTAssertEqual(updated, """
        [default]
        region = us-east-1

        [profile wga-installer]
        credential_process = "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper" get
        region = ap-northeast-2

        [profile other]
        region = eu-west-1

        """)
        // 두 번 해도 같다 (멱등성)
        XCTAssertEqual(AWSConfigFile.upsertProfile(updated, name: "wga-installer", values: values), updated)
    }

    func testCredentialProcessQuotesPathWithSpaces() {
        let helper = URL(fileURLWithPath: "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper")
        XCTAssertEqual(AWSConfigFile.credentialProcess(helper: helper),
                       "\"/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper\" get")
    }

    func testProfileNames() {
        let config = "[default]\nregion=x\n[profile wga-dev]\n[ profile spaced ]\n[sso-session my]\n"
        let credentials = "[default]\naws_access_key_id=x\n[legacy]\n"
        XCTAssertEqual(AWSConfigFile.profileNames(config: config, credentials: credentials),
                       ["default", "wga-dev", "spaced", "legacy"])
    }

    func testWriteBacksUpAndRestrictsPermissions() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = URL(fileURLWithPath: "/tmp/helper")

        // 처음: 폴더와 파일을 만든다 (백업할 원본 없음)
        XCTAssertNil(try AWSConfigFile.writeInstallerProfile(helper: helper, region: "ap-northeast-2", directory: directory))
        let dirMode = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? Int
        XCTAssertEqual(dirMode, 0o700)

        // 두 번째: 원본을 백업한 뒤 고친다
        let config = directory.appendingPathComponent("config")
        try "[default]\nregion = us-east-1\n".write(to: config, atomically: true, encoding: .utf8)
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let backup = try XCTUnwrap(try AWSConfigFile.writeInstallerProfile(helper: helper, region: "us-west-2",
                                                                           directory: directory, now: now))
        XCTAssertEqual(backup.lastPathComponent, "config.bak-\(AWSConfigFile.stamp(now))")
        XCTAssertEqual(try String(contentsOf: backup, encoding: .utf8), "[default]\nregion = us-east-1\n")
        let written = try String(contentsOf: config, encoding: .utf8)
        XCTAssertTrue(written.hasPrefix("[default]\nregion = us-east-1\n\n[profile wga-installer]\n"))
        XCTAssertTrue(written.contains("region = us-west-2"))
        let fileMode = try FileManager.default.attributesOfItem(atPath: config.path)[.posixPermissions] as? Int
        XCTAssertEqual(fileMode, 0o600)
    }
}
