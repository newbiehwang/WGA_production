import Foundation

/// ~/.aws/config 편집. 설치 마법사가 만드는 `[profile wga-installer]` 섹션만 추가·갱신하고
/// 다른 섹션과 주석은 한 글자도 바꾸지 않는다. 고치기 전에 원본을 config.bak-<시각>으로 복사해 둔다.
public enum AWSConfigFile {
    public static let profileName = "wga-installer"

    /// credential_process 값. 경로에 공백이 있으면(예: "/Applications/WGA Installer.app/...") AWS CLI가
    /// 공백에서 명령을 끊으므로 큰따옴표로 감싼다 (AWS CLI 문서의 credential_process 규칙).
    public static func credentialProcess(helper: URL) -> String {
        "\"\(helper.path)\" get"
    }

    /// text에서 [profile <name>] 섹션을 values로 바꾼 결과. 섹션이 없으면 끝에 새로 붙인다.
    public static func upsertProfile(_ text: String, name: String, values: [(String, String)]) -> String {
        var lines = text.components(separatedBy: "\n")
        if lines.last == "" { lines.removeLast() }   // 끝의 줄바꿈은 마지막에 다시 붙인다
        let header = "[profile \(name)]"
        let body = values.map { "\($0.0) = \($0.1)" }

        if let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == header }) {
            // 다음 섹션 머리([...])가 나오기 전까지가 이 섹션이다
            var end = start + 1
            while end < lines.count, !isSectionHeader(lines[end]) { end += 1 }
            // 섹션 끝의 빈 줄은 섹션 사이 간격이므로 그대로 둔다
            var contentEnd = end
            while contentEnd > start + 1, lines[contentEnd - 1].trimmingCharacters(in: .whitespaces).isEmpty {
                contentEnd -= 1
            }
            lines.replaceSubrange((start + 1)..<contentEnd, with: body)
        } else {
            if let last = lines.last, !last.trimmingCharacters(in: .whitespaces).isEmpty { lines.append("") }
            lines.append(header)
            lines.append(contentsOf: body)
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// config·credentials 파일에 있는 프로필 이름 ("기존 AWS 프로필 사용" 목록용)
    public static func profileNames(config: String, credentials: String) -> [String] {
        var names: [String] = []
        func add(_ name: String) { if !name.isEmpty, !names.contains(name) { names.append(name) } }
        for line in config.components(separatedBy: "\n") where isSectionHeader(line) {
            let inner = sectionName(line)
            if inner == "default" { add("default") }
            else if inner.hasPrefix("profile ") { add(String(inner.dropFirst("profile ".count)).trimmingCharacters(in: .whitespaces)) }
        }
        // credentials 파일은 [profile ...] 없이 이름만 쓴다
        for line in credentials.components(separatedBy: "\n") where isSectionHeader(line) { add(sectionName(line)) }
        return names
    }

    /// 설치 마법사 프로필을 파일에 쓴다. 바꾸기 전 원본을 백업하고 백업 경로를 돌려준다 (원본이 없었으면 nil).
    @discardableResult
    public static func writeInstallerProfile(helper: URL, region: String,
                                             directory: URL = defaultDirectory(), now: Date = Date()) throws -> URL? {
        let fm = FileManager.default
        // ~/.aws 폴더가 없으면 소유자만 접근할 수 있게 만든다 (AWS CLI가 만드는 권한과 같다)
        if !fm.fileExists(atPath: directory.path) {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
        }
        let file = directory.appendingPathComponent("config")
        var backup: URL?
        var original = ""
        if fm.fileExists(atPath: file.path) {
            original = try String(contentsOf: file, encoding: .utf8)
            let stamp = Self.stamp(now)
            let target = directory.appendingPathComponent("config.bak-\(stamp)")
            try? fm.removeItem(at: target)
            try fm.copyItem(at: file, to: target)
            backup = target
        }
        let updated = upsertProfile(original, name: profileName,
                                    values: [("credential_process", credentialProcess(helper: helper)), ("region", region)])
        try Data(updated.utf8).write(to: file, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return backup
    }

    public static func defaultDirectory() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".aws")
    }

    static func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }

    private static func isSectionHeader(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("[") && trimmed.hasSuffix("]")
    }

    private static func sectionName(_ line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return String(trimmed.dropFirst().dropLast()).trimmingCharacters(in: .whitespaces)
    }
}
