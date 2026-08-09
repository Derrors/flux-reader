import Foundation
import XCTest

@testable import FluxReader

final class LocalFileServiceTests: XCTestCase {
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

  func testLoadsUTF8Markdown() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let source = "# Flux Reader\n\n原生 macOS 阅读器"
    try Data(source.utf8).write(to: url)

    let document = try LocalFileService().loadDocument(at: url)

    XCTAssertEqual(document.url, url.standardizedFileURL)
    XCTAssertEqual(document.content, source)
    XCTAssertEqual(document.byteCount, Data(source.utf8).count)
  }

  func testRejectsUnsupportedFileType() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.txt")
    try Data("plain text".utf8).write(to: url)

    XCTAssertThrowsError(try LocalFileService().loadDocument(at: url)) { error in
      XCTAssertEqual(error as? FileAccessError, .unsupportedFileType("txt"))
    }
  }

  func testRejectsOversizedFile() throws {
    let url = temporaryDirectory.appendingPathComponent("large.md")
    try Data(repeating: 65, count: 17).write(to: url)

    XCTAssertThrowsError(
      try LocalFileService(maximumFileSize: 16).loadDocument(at: url)
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileTooLarge(actual: 17, limit: 16))
    }
  }

  func testRejectsInvalidUTF8() throws {
    let url = temporaryDirectory.appendingPathComponent("invalid.md")
    try Data([0xC3, 0x28]).write(to: url)

    XCTAssertThrowsError(try LocalFileService().loadDocument(at: url)) { error in
      XCTAssertEqual(error as? FileAccessError, .invalidUTF8)
    }
  }
}
