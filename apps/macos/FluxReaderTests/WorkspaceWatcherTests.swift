import Foundation
import XCTest

@testable import FluxReader

final class WorkspaceWatcherTests: XCTestCase {
  func testReportsRecursiveFileChanges() throws {
    let rootURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let nestedURL = rootURL.appendingPathComponent("nested", isDirectory: true)
    try FileManager.default.createDirectory(at: nestedURL, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: rootURL) }

    let changed = expectation(description: "FSEvents reports nested change")
    changed.assertForOverFulfill = false
    let token = try FSEventWorkspaceWatcher(latency: 0.05).watch(rootURL: rootURL) {
      changed.fulfill()
    }
    defer { token.cancel() }

    try Data("# Changed".utf8).write(
      to: nestedURL.appendingPathComponent("README.md")
    )
    wait(for: [changed], timeout: 5)
  }
}
