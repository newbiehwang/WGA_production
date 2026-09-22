import Foundation

/// 점검 결과 안내(hint)에서 터미널에 붙여 넣을 명령을 뽑는다 ("복사" 버튼용).
/// CLI의 안내는 "brew install awscli v1이 설치되어 있다면 먼저 제거하세요 (...)"처럼 명령 뒤에 설명이 이어지므로,
/// 알려진 명령으로 시작하는 부분에서 앞의 세 단어만 가져온다 (brew install <패키지>, gh auth login, brew upgrade <패키지>).
public enum CommandHint {
    static let prefixes = ["brew install ", "brew upgrade ", "gh auth login"]

    public static func copyableCommand(in hint: String) -> String? {
        for prefix in prefixes {
            guard let range = hint.range(of: prefix) else { continue }
            let words = hint[range.lowerBound...].split(separator: " ", omittingEmptySubsequences: true)
                .prefix(3)
                // "gh auth login을"처럼 한국어 조사가 붙은 경우: 명령 단어는 영문·숫자·기호로만 되어 있으므로 그 앞부분만
                .map { word in String(word.prefix(while: { $0.isASCII && !$0.isWhitespace })) }
            return words.joined(separator: " ")
        }
        return nil
    }
}
