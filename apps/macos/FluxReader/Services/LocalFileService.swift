import Foundation

protocol FileAccessing: Sendable {
  func loadDocument(at url: URL) throws -> MarkdownDocument
}

enum FileAccessError: LocalizedError, Equatable, Sendable {
  case unsupportedFileType(String)
  case notRegularFile
  case fileTooLarge(actual: Int, limit: Int)
  case invalidUTF8

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
}
