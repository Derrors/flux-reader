import Foundation
import XCTest

@testable import FluxReader

final class WorkspaceSearchServiceTests: XCTestCase {
  private var temporaryDirectory: URL!

  override func setUpWithError() throws {
    temporaryDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(
      at: temporaryDirectory,
      withIntermediateDirectories: true
    )
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: temporaryDirectory)
    temporaryDirectory = nil
  }

  func testSearchesFileNamesBeforeDocumentContents() throws {
    let namedURL = temporaryDirectory.appendingPathComponent("Architecture.md")
    let contentURL = temporaryDirectory.appendingPathComponent("guide.md")
    try Data("unrelated".utf8).write(to: namedURL)
    try Data("The architecture uses a native shell.".utf8).write(to: contentURL)
    let workspace = WorkspaceSnapshot(
      rootURL: temporaryDirectory,
      children: [
        WorkspaceNode(
          url: namedURL,
          name: namedURL.lastPathComponent,
          kind: .document,
          children: []
        ),
        WorkspaceNode(
          url: contentURL,
          name: contentURL.lastPathComponent,
          kind: .document,
          children: []
        ),
      ],
      documentCount: 2
    )

    let results = try LocalWorkspaceSearchService().search(
      query: "architecture",
      workspaces: [workspace]
    )

    XCTAssertEqual(results.map(\.documentURL), [namedURL, contentURL])
    XCTAssertEqual(results.map(\.matchKind), [.fileName, .content])
    XCTAssertEqual(results.last?.snippet, "The architecture uses a native shell.")
  }

  func testSkipsOversizedAndInvalidUTF8Documents() throws {
    let oversizedURL = temporaryDirectory.appendingPathComponent("oversized.md")
    let invalidURL = temporaryDirectory.appendingPathComponent("invalid.md")
    try Data("needle".utf8).write(to: oversizedURL)
    try Data([0xFF, 0xFE]).write(to: invalidURL)
    let workspace = WorkspaceSnapshot(
      rootURL: temporaryDirectory,
      children: [oversizedURL, invalidURL].map {
        WorkspaceNode(
          url: $0,
          name: $0.lastPathComponent,
          kind: .document,
          children: []
        )
      },
      documentCount: 2
    )

    let results = try LocalWorkspaceSearchService(maximumFileSize: 4).search(
      query: "needle",
      workspaces: [workspace]
    )

    XCTAssertTrue(results.isEmpty)
  }

  func testKeepsFileNameMatchesAheadOfEarlierContentMatchesAtLimit() throws {
    let contentURL = temporaryDirectory.appendingPathComponent("a.md")
    let namedURL = temporaryDirectory.appendingPathComponent("z-needle.md")
    try Data("needle in content".utf8).write(to: contentURL)
    try Data("unrelated".utf8).write(to: namedURL)
    let workspace = snapshot(rootURL: temporaryDirectory, documents: [contentURL, namedURL])

    let results = try LocalWorkspaceSearchService(maximumResultCount: 1).search(
      query: "needle",
      workspaces: [workspace]
    )

    XCTAssertEqual(results.map(\.documentURL), [namedURL])
    XCTAssertEqual(results.map(\.matchKind), [.fileName])
  }

  func testDeduplicatesOverlappingWorkspacesAndUsesDeepestResourceRoot() throws {
    let nestedURL = temporaryDirectory.appendingPathComponent("Nested", isDirectory: true)
    try FileManager.default.createDirectory(at: nestedURL, withIntermediateDirectories: true)
    let documentURL = nestedURL.appendingPathComponent("needle.md")
    try Data("content".utf8).write(to: documentURL)
    let outer = snapshot(rootURL: temporaryDirectory, documents: [documentURL])
    let inner = snapshot(rootURL: nestedURL, documents: [documentURL])

    let results = try LocalWorkspaceSearchService().search(
      query: "needle",
      workspaces: [outer, inner]
    )

    XCTAssertEqual(results.count, 1)
    XCTAssertEqual(results.first?.workspaceRootURL, nestedURL)
    XCTAssertEqual(results.first?.relativePath, "needle.md")
  }

  private func snapshot(rootURL: URL, documents: [URL]) -> WorkspaceSnapshot {
    WorkspaceSnapshot(
      rootURL: rootURL,
      children: documents.map {
        WorkspaceNode(
          url: $0,
          name: $0.lastPathComponent,
          kind: .document,
          children: []
        )
      },
      documentCount: documents.count
    )
  }
}
