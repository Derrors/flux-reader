import Darwin
import Foundation
import XCTest

@testable import FluxReader

final class SafeSaveContractTests: XCTestCase {
  private struct ScenarioCorpus: Decodable {
    let contractVersion: Int
    let scenarios: [Scenario]
  }

  private struct Scenario: Decodable {
    let id: String
    let expected: Expected
    let platformSignals: PlatformSignals
  }

  private struct Expected: Decodable {
    let kind: SafeSaveOutcomeKind
    let reason: SafeSaveRejectionReason?
    let commitState: SafeSaveCommitState?
  }

  private struct PlatformSignals: Decodable {
    let macos: String
  }

  func testAdapterMapsEverySharedScenarioToItsContractOutcome() throws {
    let corpus = try loadCorpus()
    XCTAssertEqual(corpus.contractVersion, SafeSaveOutcome.contractVersion)
    XCTAssertEqual(Set(corpus.scenarios.map(\.id)).count, corpus.scenarios.count)

    for scenario in corpus.scenarios {
      let outcome = outcome(for: scenario.platformSignals.macos)
      XCTAssertEqual(outcome.kind, scenario.expected.kind, scenario.id)
      if let reason = scenario.expected.reason {
        XCTAssertEqual(outcome.reason, reason, scenario.id)
      }
      if let commitState = scenario.expected.commitState {
        XCTAssertEqual(outcome.commitState, commitState, scenario.id)
      }
    }
  }

  func testRejectionReasonsStayExhaustiveWithSharedSchema() throws {
    let schemaURL = contractDirectory.appendingPathComponent("schema.json")
    let object = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: schemaURL)) as? [String: Any]
    )
    let definitions = try XCTUnwrap(object["$defs"] as? [String: Any])
    let rejection = try XCTUnwrap(definitions["rejectionReason"] as? [String: Any])
    let schemaReasons = try XCTUnwrap(rejection["enum"] as? [String])
    XCTAssertEqual(Set(schemaReasons), Set(SafeSaveRejectionReason.allCases.map(\.rawValue)))
  }

  func testCommittedSnapshotUsesOpaqueVersionAndMacOSSemantics() throws {
    let document = MarkdownDocument(
      url: URL(fileURLWithPath: "/Users/example/private-note.md"),
      content: "secret body",
      byteCount: 11,
      modificationDate: Date(timeIntervalSince1970: 12)
    )
    let outcome = SafeSaveContract.committed(
      document: document,
      locator: "document://active"
    )
    let snapshot = try XCTUnwrap(outcome.snapshot)
    XCTAssertEqual(outcome.kind, .committed)
    XCTAssertEqual(snapshot.locator, "document://active")
    XCTAssertFalse(snapshot.contentIncluded)
    XCTAssertNil(snapshot.content)
    XCTAssertEqual(snapshot.implementationSemantics.writeVisibility, .atomicReplace)
    XCTAssertEqual(snapshot.implementationSemantics.recoveryLocation, .sidecar)
    XCTAssertFalse(snapshot.version.contains("secret body"))
    XCTAssertFalse(snapshot.version.contains("private-note"))
  }

  func testRecoveryReferenceDoesNotExposeSidecarPath() throws {
    let path = "/Users/example/.note.md.flux-reader-recovery"
    let outcome = SafeSaveContract.failed(
      error: FileAccessError.saveRecoveryRequired(path)
    )
    XCTAssertEqual(outcome.kind, .recoveryRequired)
    XCTAssertEqual(outcome.commitState, .unknown)
    let reference = try XCTUnwrap(outcome.recoveryReferences.first?.reference)
    XCTAssertFalse(reference.contains(path))
    XCTAssertTrue(reference.hasPrefix("sidecar:"))
  }

  private func outcome(for signal: String) -> SafeSaveOutcome {
    switch signal {
    case "COMMITTED":
      return SafeSaveContract.committed(
        document: MarkdownDocument(
          url: URL(fileURLWithPath: "/tmp/contract.md"),
          content: "# saved",
          byteCount: 7,
          modificationDate: Date(timeIntervalSince1970: 1)
        ),
        locator: "document://contract"
      )
    case "fileModifiedExternally":
      return SafeSaveContract.failed(error: FileAccessError.fileModifiedExternally)
    case "permissionDenied":
      return SafeSaveContract.failed(
        error: NSError(domain: NSPOSIXErrorDomain, code: Int(EACCES))
      )
    case "unavailable":
      return SafeSaveContract.failed(
        error: NSError(domain: NSPOSIXErrorDomain, code: Int(ETIMEDOUT))
      )
    case "resourceExhausted":
      return SafeSaveContract.failed(
        error: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
      )
    case "saveRecoveryRequired":
      return SafeSaveContract.failed(
        error: FileAccessError.saveRecoveryRequired("/private/recovery.md")
      )
    case "notRegularFile":
      return SafeSaveContract.failed(error: FileAccessError.notRegularFile)
    default:
      return SafeSaveContract.failed(
        error: NSError(domain: "SafeSaveContractTests", code: 1)
      )
    }
  }

  private func loadCorpus() throws -> ScenarioCorpus {
    let data = try Data(contentsOf: contractDirectory.appendingPathComponent("scenarios.json"))
    return try JSONDecoder().decode(ScenarioCorpus.self, from: data)
  }

  private var contractDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("contracts/safe-save/v1", isDirectory: true)
  }
}
