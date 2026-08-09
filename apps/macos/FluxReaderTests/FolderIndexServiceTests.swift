import Foundation
import XCTest

@testable import FluxReader

final class FolderIndexServiceTests: XCTestCase {
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

  func testIndexesMarkdownAsSortedTreeAndSkipsUnsafeEntries() throws {
    let guides = temporaryDirectory.appendingPathComponent("Guides", isDirectory: true)
    let empty = temporaryDirectory.appendingPathComponent("Empty", isDirectory: true)
    try FileManager.default.createDirectory(at: guides, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
    try Data("# API".utf8).write(to: guides.appendingPathComponent("API.mdx"))
    try Data("# Root".utf8).write(to: temporaryDirectory.appendingPathComponent("README.md"))
    try Data("ignore".utf8).write(to: temporaryDirectory.appendingPathComponent("note.txt"))
    try Data("hidden".utf8).write(to: temporaryDirectory.appendingPathComponent(".hidden.md"))
    try FileManager.default.createSymbolicLink(
      at: temporaryDirectory.appendingPathComponent("linked.md"),
      withDestinationURL: guides.appendingPathComponent("API.mdx")
    )

    let snapshot = try LocalFolderIndexService().indexFolder(at: temporaryDirectory)

    XCTAssertEqual(snapshot.documentCount, 2)
    XCTAssertEqual(snapshot.children.map(\.name), ["Guides", "README.md"])
    XCTAssertEqual(snapshot.children.first?.kind, .folder)
    XCTAssertEqual(snapshot.children.first?.children.map(\.name), ["API.mdx"])
  }

  func testRejectsNonDirectoryRoot() throws {
    let fileURL = temporaryDirectory.appendingPathComponent("README.md")
    try Data("# Test".utf8).write(to: fileURL)

    XCTAssertThrowsError(try LocalFolderIndexService().indexFolder(at: fileURL)) { error in
      XCTAssertEqual(error as? FolderIndexError, .notDirectory)
    }
  }

  func testStopsScanningWhenEntryLimitIsExceeded() throws {
    try Data("# A".utf8).write(to: temporaryDirectory.appendingPathComponent("a.md"))
    try Data("# B".utf8).write(to: temporaryDirectory.appendingPathComponent("b.md"))

    XCTAssertThrowsError(
      try LocalFolderIndexService(maximumEntryCount: 1).indexFolder(
        at: temporaryDirectory
      )
    ) { error in
      XCTAssertEqual(error as? FolderIndexError, .tooManyEntries(limit: 1))
    }
  }

  func testRejectsSymbolicLinkRoot() throws {
    let target = temporaryDirectory.appendingPathComponent("target", isDirectory: true)
    let link = temporaryDirectory.appendingPathComponent("linked-folder", isDirectory: true)
    try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(
      at: link,
      withDestinationURL: target
    )

    XCTAssertThrowsError(try LocalFolderIndexService().indexFolder(at: link)) { error in
      XCTAssertEqual(error as? FolderIndexError, .symbolicLinkRoot)
    }
  }
}
