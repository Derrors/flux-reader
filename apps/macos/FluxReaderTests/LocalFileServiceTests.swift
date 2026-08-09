import Darwin
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

  func testSavesUTF8MarkdownAndReturnsLatestSnapshot() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Before".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let updatedSource = "# After\n\n保存后的中文内容"

    let savedDocument = try service.saveDocument(
      content: updatedSource,
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), updatedSource)
    XCTAssertEqual(savedDocument.url, url.standardizedFileURL)
    XCTAssertEqual(savedDocument.content, updatedSource)
    XCTAssertEqual(savedDocument.byteCount, Data(updatedSource.utf8).count)
    XCTAssertNotNil(savedDocument.modificationDate)
  }

  func testRejectsOversizedSaveWithoutChangingExistingFile() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    let originalSource = "old"
    try Data(originalSource.utf8).write(to: url)
    let service = LocalFileService(maximumFileSize: 8)
    let originalDocument = try service.loadDocument(at: url)

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "123456789",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(
        error as? FileAccessError,
        .fileTooLarge(actual: 9, limit: 8)
      )
    }

    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), originalSource)
  }

  func testRejectsSaveWhenFileWasModifiedExternally() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let externallyModifiedSource = "# External change"
    try Data(externallyModifiedSource.utf8).write(to: url)
    let externalModificationDate = try XCTUnwrap(originalDocument.modificationDate)
      .addingTimeInterval(5)
    try FileManager.default.setAttributes(
      [.modificationDate: externalModificationDate],
      ofItemAtPath: url.path(percentEncoded: false)
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local change",
        to: url,
        expectedModificationDate: originalDocument.modificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externallyModifiedSource
    )
  }

  func testRejectsSameSizeContentChangeWhenModificationDateIsPreserved() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)
    let originalModificationDate = try XCTUnwrap(originalDocument.modificationDate)
    let externallyModifiedSource = "# External"
    XCTAssertEqual(
      externallyModifiedSource.utf8.count,
      originalDocument.content.utf8.count
    )
    try Data(externallyModifiedSource.utf8).write(to: url)
    try FileManager.default.setAttributes(
      [.modificationDate: originalModificationDate],
      ofItemAtPath: url.path(percentEncoded: false)
    )

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local change",
        to: url,
        expectedModificationDate: originalModificationDate,
        expectedContent: originalDocument.content,
        expectedTargetExists: true
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      externallyModifiedSource
    )
  }

  func testSavePreservesExtendedAttributesOnExistingFile() throws {
    let url = temporaryDirectory.appendingPathComponent("sample.md")
    try Data("# Original".utf8).write(to: url)
    let attributeName = "com.derrors.flux-reader.tests"
    let attributeValue = Data("preserve-me".utf8)
    try setExtendedAttribute(attributeValue, named: attributeName, at: url)
    let service = LocalFileService()
    let originalDocument = try service.loadDocument(at: url)

    _ = try service.saveDocument(
      content: "# Saved",
      to: url,
      expectedModificationDate: originalDocument.modificationDate,
      expectedContent: originalDocument.content,
      expectedTargetExists: true
    )

    XCTAssertEqual(
      try extendedAttribute(named: attributeName, at: url),
      attributeValue
    )
  }

  func testSavesNewMarkdownWhenTargetRemainsAbsent() throws {
    let url = temporaryDirectory.appendingPathComponent("new.md")
    let service = LocalFileService()

    let savedDocument = try service.saveDocument(
      content: "# New document",
      to: url,
      expectedModificationDate: nil,
      expectedContent: nil,
      expectedTargetExists: false
    )

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      "# New document"
    )
    XCTAssertEqual(savedDocument.url, url.standardizedFileURL)
  }

  func testRejectsNewSaveWhenTargetAppearsAfterConfirmation() throws {
    let url = temporaryDirectory.appendingPathComponent("new.md")
    let competingContent = "# Created by another application"
    try Data(competingContent.utf8).write(to: url)
    let service = LocalFileService()

    XCTAssertThrowsError(
      try service.saveDocument(
        content: "# Local draft",
        to: url,
        expectedModificationDate: nil,
        expectedContent: nil,
        expectedTargetExists: false
      )
    ) { error in
      XCTAssertEqual(error as? FileAccessError, .fileModifiedExternally)
    }

    XCTAssertEqual(
      try String(contentsOf: url, encoding: .utf8),
      competingContent
    )
  }

  private func setExtendedAttribute(
    _ value: Data,
    named name: String,
    at url: URL
  ) throws {
    let result = url.path.withCString { path in
      name.withCString { attributeName in
        value.withUnsafeBytes { bytes in
          setxattr(path, attributeName, bytes.baseAddress, bytes.count, 0, 0)
        }
      }
    }
    guard result == 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
  }

  private func extendedAttribute(named name: String, at url: URL) throws -> Data {
    let length = url.path.withCString { path in
      name.withCString { attributeName in
        getxattr(path, attributeName, nil, 0, 0, 0)
      }
    }
    guard length >= 0 else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }

    var value = Data(count: length)
    let bytesRead = value.withUnsafeMutableBytes { bytes in
      url.path.withCString { path in
        name.withCString { attributeName in
          getxattr(path, attributeName, bytes.baseAddress, bytes.count, 0, 0)
        }
      }
    }
    guard bytesRead == length else {
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    return value
  }
}
