import Foundation

protocol FileAccessing: Sendable {
  func loadDocument(at url: URL) throws -> MarkdownDocument
  func saveDocument(
    content: String,
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws -> MarkdownDocument
}

enum FileAccessError: LocalizedError, Equatable, Sendable {
  case unsupportedFileType(String)
  case notRegularFile
  case fileTooLarge(actual: Int, limit: Int)
  case invalidUTF8
  case fileModifiedExternally

  var errorDescription: String? {
    switch self {
    case .unsupportedFileType(let fileExtension):
      let suffix = fileExtension.isEmpty ? "无扩展名" : ".\(fileExtension)"
      return "不支持 \(suffix) 文件，请选择 Markdown 文稿。"
    case .notRegularFile:
      return "所选项目不是可读取的普通文件。"
    case .fileTooLarge(let actual, let limit):
      let formatter = ByteCountFormatter()
      formatter.countStyle = .file
      return
        "文件大小为 \(formatter.string(fromByteCount: Int64(actual)))，超过 \(formatter.string(fromByteCount: Int64(limit))) 限制。"
    case .invalidUTF8:
      return "文件不是有效的 UTF-8 文本。"
    case .fileModifiedExternally:
      return "文件已被其他应用修改。请从磁盘重新载入，或使用“另存为”保留当前草稿。"
    }
  }
}

struct LocalFileService: FileAccessing {
  static let defaultMaximumFileSize = 2 * 1_024 * 1_024

  let maximumFileSize: Int

  init(maximumFileSize: Int = defaultMaximumFileSize) {
    self.maximumFileSize = maximumFileSize
  }

  func loadDocument(at url: URL) throws -> MarkdownDocument {
    guard MarkdownDocument.supports(url) else {
      throw FileAccessError.unsupportedFileType(url.pathExtension)
    }

    let hasSecurityScope = url.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope {
        url.stopAccessingSecurityScopedResource()
      }
    }

    let values = try url.resourceValues(forKeys: [
      .isRegularFileKey,
      .fileSizeKey,
      .contentModificationDateKey,
    ])

    guard values.isRegularFile == true else {
      throw FileAccessError.notRegularFile
    }

    if let fileSize = values.fileSize, fileSize > maximumFileSize {
      throw FileAccessError.fileTooLarge(actual: fileSize, limit: maximumFileSize)
    }

    let data = try Data(contentsOf: url, options: .mappedIfSafe)
    guard data.count <= maximumFileSize else {
      throw FileAccessError.fileTooLarge(actual: data.count, limit: maximumFileSize)
    }
    guard let content = String(data: data, encoding: .utf8) else {
      throw FileAccessError.invalidUTF8
    }

    return MarkdownDocument(
      url: url.standardizedFileURL,
      content: content,
      byteCount: data.count,
      modificationDate: values.contentModificationDate
    )
  }

  func saveDocument(
    content: String,
    to url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws -> MarkdownDocument {
    guard MarkdownDocument.supports(url) else {
      throw FileAccessError.unsupportedFileType(url.pathExtension)
    }

    let data = Data(content.utf8)
    guard data.count <= maximumFileSize else {
      throw FileAccessError.fileTooLarge(actual: data.count, limit: maximumFileSize)
    }

    let hasSecurityScope = url.startAccessingSecurityScopedResource()
    defer {
      if hasSecurityScope {
        url.stopAccessingSecurityScopedResource()
      }
    }

    let coordinator = NSFileCoordinator(filePresenter: nil)
    var coordinationError: NSError?
    var writeResult: Result<MarkdownDocument, Error>?
    let writingOptions: NSFileCoordinator.WritingOptions =
      FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
      ? .forReplacing : []

    coordinator.coordinate(
      writingItemAt: url,
      options: writingOptions,
      error: &coordinationError
    ) { coordinatedURL in
      writeResult = Result {
        try validateWriteTarget(
          at: coordinatedURL,
          expectedModificationDate: expectedModificationDate,
          expectedContent: expectedContent,
          expectedTargetExists: expectedTargetExists
        )
        try writeDataPreservingMetadata(data, to: coordinatedURL)

        let attributes = try FileManager.default.attributesOfItem(
          atPath: coordinatedURL.path(percentEncoded: false)
        )
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
          throw FileAccessError.notRegularFile
        }

        return MarkdownDocument(
          url: coordinatedURL.standardizedFileURL,
          content: content,
          byteCount: data.count,
          modificationDate: attributes[.modificationDate] as? Date
        )
      }
    }

    if let coordinationError {
      throw coordinationError
    }
    guard let writeResult else {
      throw CocoaError(.fileWriteUnknown)
    }
    return try writeResult.get()
  }

  private func validateWriteTarget(
    at url: URL,
    expectedModificationDate: Date?,
    expectedContent: String?,
    expectedTargetExists: Bool
  ) throws {
    let fileExists = FileManager.default.fileExists(
      atPath: url.path(percentEncoded: false)
    )
    guard fileExists else {
      if expectedTargetExists || expectedModificationDate != nil || expectedContent != nil {
        throw FileAccessError.fileModifiedExternally
      }
      return
    }
    guard expectedTargetExists else {
      throw FileAccessError.fileModifiedExternally
    }

    // URL resource values may be cached on a URL that was used to open the
    // document. FileManager attributes force a fresh snapshot for the
    // last-moment conflict check inside the coordinated write.
    let attributes = try FileManager.default.attributesOfItem(
      atPath: url.path(percentEncoded: false)
    )
    guard attributes[.type] as? FileAttributeType == .typeRegular else {
      throw FileAccessError.notRegularFile
    }
    if let expectedModificationDate {
      guard attributes[.modificationDate] as? Date == expectedModificationDate else {
        throw FileAccessError.fileModifiedExternally
      }
    }
    if let expectedContent {
      let expectedData = Data(expectedContent.utf8)
      guard
        let currentSize = attributes[.size] as? NSNumber,
        currentSize.intValue == expectedData.count
      else {
        throw FileAccessError.fileModifiedExternally
      }

      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      let currentData = try handle.read(upToCount: expectedData.count + 1) ?? Data()
      guard currentData == expectedData else {
        throw FileAccessError.fileModifiedExternally
      }
    }
  }

  private func writeDataPreservingMetadata(_ data: Data, to url: URL) throws {
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: url.path(percentEncoded: false)) else {
      try data.write(to: url, options: .atomic)
      return
    }

    let replacementDirectoryURL = try fileManager.url(
      for: .itemReplacementDirectory,
      in: .userDomainMask,
      appropriateFor: url,
      create: true
    )
    let temporaryURL = replacementDirectoryURL.appendingPathComponent(
      url.lastPathComponent,
      isDirectory: false
    )
    defer {
      try? fileManager.removeItem(at: replacementDirectoryURL)
    }

    try data.write(to: temporaryURL, options: .atomic)
    _ = try fileManager.replaceItemAt(url, withItemAt: temporaryURL)
  }
}
