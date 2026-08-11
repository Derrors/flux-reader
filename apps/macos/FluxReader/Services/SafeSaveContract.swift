import CryptoKit
import Darwin
import Foundation

enum SafeSaveOutcomeKind: String, Codable, Equatable, Sendable {
  case committed
  case rejected
  case recoveryRequired
}

enum SafeSaveRejectionReason: String, Codable, CaseIterable, Equatable, Sendable {
  case conflict
  case permission
  case invalidTarget
  case tooLarge
  case invalidUTF8
  case resourceExhausted
  case unavailable
  case cancelled
  case `internal`
}

enum SafeSaveCommitState: String, Codable, Equatable, Sendable {
  case notCommitted
  case committed
  case unknown
}

enum SafeSaveWriteVisibility: String, Codable, Equatable, Sendable {
  case atomicReplace
  case recoverableInPlace
}

enum SafeSaveRecoveryLocation: String, Codable, Equatable, Sendable {
  case `private`
  case sidecar
}

struct SafeSaveCapabilities: Codable, Equatable, Sendable {
  let readable: Bool
  let writable: Bool
  let supportsCreate: Bool
  let supportsSaveAs: Bool
}

struct SafeSaveImplementationSemantics: Codable, Equatable, Sendable {
  let writeVisibility: SafeSaveWriteVisibility
  let recoveryLocation: SafeSaveRecoveryLocation
}

struct SafeSaveSnapshot: Codable, Equatable, Sendable {
  let locator: String
  let version: String
  let content: String?
  let contentIncluded: Bool
  let byteCount: Int
  let capabilities: SafeSaveCapabilities
  let implementationSemantics: SafeSaveImplementationSemantics
}

struct SafeSaveRecoveryReference: Codable, Equatable, Sendable {
  enum Kind: String, Codable, Equatable, Sendable {
    case privateJournal
    case retainedSidecar
    case cleanupPending
  }

  let kind: Kind
  let reference: String
  let phase: String?
}

struct SafeSaveOutcome: Codable, Equatable, Sendable {
  static let contractVersion = 1

  let contractVersion: Int
  let kind: SafeSaveOutcomeKind
  let snapshot: SafeSaveSnapshot?
  let reason: SafeSaveRejectionReason?
  let commitState: SafeSaveCommitState?
  let recoveryReferences: [SafeSaveRecoveryReference]
  let currentVersion: String?
}

enum SafeSaveContract {
  static func committed(
    document: MarkdownDocument,
    locator: String? = nil,
    includeContent: Bool = false
  ) -> SafeSaveOutcome {
    SafeSaveOutcome(
      contractVersion: SafeSaveOutcome.contractVersion,
      kind: .committed,
      snapshot: SafeSaveSnapshot(
        locator: locator ?? document.url.standardizedFileURL.absoluteString,
        version: versionToken(for: document),
        content: includeContent ? document.content : nil,
        contentIncluded: includeContent,
        byteCount: document.byteCount,
        capabilities: SafeSaveCapabilities(
          readable: true,
          writable: true,
          supportsCreate: true,
          supportsSaveAs: true
        ),
        implementationSemantics: SafeSaveImplementationSemantics(
          writeVisibility: .atomicReplace,
          recoveryLocation: .sidecar
        )
      ),
      reason: nil,
      commitState: nil,
      recoveryReferences: [],
      currentVersion: nil
    )
  }

  static func failed(error: Error) -> SafeSaveOutcome {
    if case .saveRecoveryRequired(let path) = error as? FileAccessError {
      return SafeSaveOutcome(
        contractVersion: SafeSaveOutcome.contractVersion,
        kind: .recoveryRequired,
        snapshot: nil,
        reason: nil,
        commitState: .unknown,
        recoveryReferences: [
          SafeSaveRecoveryReference(
            kind: .retainedSidecar,
            reference: opaqueReference(for: path),
            phase: "recovery-required"
          )
        ],
        currentVersion: nil
      )
    }

    return SafeSaveOutcome(
      contractVersion: SafeSaveOutcome.contractVersion,
      kind: .rejected,
      snapshot: nil,
      reason: rejectionReason(for: error),
      commitState: nil,
      recoveryReferences: [],
      currentVersion: nil
    )
  }

  static func versionToken(for document: MarkdownDocument) -> String {
    var material = Data(document.content.utf8)
    material.append(0)
    material.append(
      Data(
        "\(document.byteCount):\(document.modificationDate?.timeIntervalSince1970.bitPattern ?? 0)"
          .utf8
      )
    )
    return "macos:\(hexDigest(material))"
  }

  private static func rejectionReason(for error: Error) -> SafeSaveRejectionReason {
    if error is CancellationError { return .cancelled }

    if let accessError = error as? FileAccessError {
      switch accessError {
      case .unsupportedFileType, .notRegularFile:
        return .invalidTarget
      case .fileTooLarge:
        return .tooLarge
      case .invalidUTF8:
        return .invalidUTF8
      case .fileModifiedExternally:
        return .conflict
      case .saveRecoveryRequired:
        // Handled before this function; retain a fail-closed classification if
        // a future call site bypasses that branch.
        return .internal
      }
    }

    let nsError = error as NSError
    if nsError.domain == NSPOSIXErrorDomain {
      switch Int32(nsError.code) {
      case EACCES, EPERM, EROFS:
        return .permission
      case ENOSPC, EDQUOT:
        return .resourceExhausted
      case EMFILE, ENFILE, ENOMEM, ESTALE, EBUSY, ETIMEDOUT:
        return .unavailable
      default:
        break
      }
    }

    if nsError.domain == NSCocoaErrorDomain {
      switch nsError.code {
      case CocoaError.Code.fileReadNoPermission.rawValue,
        CocoaError.Code.fileWriteNoPermission.rawValue,
        CocoaError.Code.fileWriteVolumeReadOnly.rawValue:
        return .permission
      case CocoaError.Code.fileWriteOutOfSpace.rawValue:
        return .resourceExhausted
      case CocoaError.Code.fileWriteFileExists.rawValue:
        return .conflict
      case CocoaError.Code.fileNoSuchFile.rawValue:
        return .invalidTarget
      default:
        break
      }
    }

    if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? Error {
      return rejectionReason(for: underlying)
    }
    return .internal
  }

  private static func opaqueReference(for value: String) -> String {
    "sidecar:\(hexDigest(Data(value.utf8)))"
  }

  private static func hexDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
