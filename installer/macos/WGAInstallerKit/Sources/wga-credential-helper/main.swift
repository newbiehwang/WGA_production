// wga-credential-helper: AWS CLI credential_process용 도구 (앱 번들의 Contents/MacOS에 들어간다)
//
// ~/.aws/config 예:
//     [profile wga-installer]
//     credential_process = "/Applications/WGA Installer.app/Contents/MacOS/wga-credential-helper" get
//
// 명령 설명은 CredentialStore/HelperCommand.swift 참고.
import CredentialStore
import Foundation

// 키체인이 허용 창을 띄우지 못하게 한다. AWS CLI가 화면 없이 부르므로 창이 뜨면 명령이 멈춘다 (KeychainStore 설명 참고)
KeychainStore.disableUserInteraction()

// WGA_KEYCHAIN_PATH: 로그인 키체인 대신 쓸 키체인 파일. 테스트와 동작 확인에서만 쓴다
let store = KeychainStore(keychainPath: ProcessInfo.processInfo.environment["WGA_KEYCHAIN_PATH"])
let output = HelperCommand.run(arguments: Array(CommandLine.arguments.dropFirst()),
                               stdin: { FileHandle.standardInput.readDataToEndOfFile() },
                               store: store)
FileHandle.standardOutput.write(Data(output.stdout.utf8))
FileHandle.standardError.write(Data(output.stderr.utf8))
exit(output.exitCode)
