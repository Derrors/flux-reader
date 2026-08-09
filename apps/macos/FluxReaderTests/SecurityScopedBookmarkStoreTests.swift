import Foundation
import XCTest

@testable import FluxReader

final class SecurityScopedBookmarkStoreTests: XCTestCase {
  private var defaults: UserDefaults!
  private var suiteName: String!

  override func setUpWithError() throws {
    suiteName = "FluxReaderTests.\(UUID().uuidString)"
    defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
  }

  override func tearDownWithError() throws {
    defaults.removePersistentDomain(forName: suiteName)
    defaults = nil
    suiteName = nil
  }

  func testPersistsDeduplicatesAndClearsWorkspaceBookmarks() throws {
    let store = makeStore()
    let first = URL(fileURLWithPath: "/tmp/Flux Reader One", isDirectory: true)
    let second = URL(fileURLWithPath: "/tmp/Flux Reader Two", isDirectory: true)

    try store.saveWorkspace(first)
    try store.saveWorkspace(second)
    try store.saveWorkspace(first)

    XCTAssertEqual(store.restoreWorkspaces(), [first, second])
    store.removeWorkspace(first)
    XCTAssertEqual(store.restoreWorkspaces(), [second])
    store.clearWorkspaces()
    XCTAssertTrue(store.restoreWorkspaces().isEmpty)
  }

  func testRecentDocumentsDeduplicateMoveToFrontAndRespectLimit() throws {
    let store = makeStore(maximumRecentCount: 2)
    let first = URL(fileURLWithPath: "/tmp/first.md")
    let second = URL(fileURLWithPath: "/tmp/second.mdx")
    let third = URL(fileURLWithPath: "/tmp/third.markdown")

    try store.recordRecentDocument(first)
    try store.recordRecentDocument(second)
    try store.recordRecentDocument(first)
    XCTAssertEqual(store.restoreRecentDocuments().map(\.url), [first, second])

    try store.recordRecentDocument(third)
    XCTAssertEqual(store.restoreRecentDocuments().map(\.url), [third, first])

    store.removeRecentDocument(third)
    XCTAssertEqual(store.restoreRecentDocuments().map(\.url), [first])
    store.clearRecentDocuments()
    XCTAssertTrue(store.restoreRecentDocuments().isEmpty)
  }

  private func makeStore(maximumRecentCount: Int = 12) -> SecurityScopedBookmarkStore {
    let codec = SecurityScopedBookmarkCodec(
      create: { Data($0.standardizedFileURL.path(percentEncoded: false).utf8) },
      resolve: { data in
        let path = String(decoding: data, as: UTF8.self)
        return BookmarkResolution(
          url: URL(fileURLWithPath: path),
          isStale: false
        )
      }
    )
    return SecurityScopedBookmarkStore(
      defaults: defaults,
      namespace: suiteName,
      maximumRecentCount: maximumRecentCount,
      codec: codec
    )
  }
}
