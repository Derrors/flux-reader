import Darwin
import Foundation
import UniformTypeIdentifiers
import WebKit

struct DocumentResourceContext: Equatable, Sendable {
  let documentURL: URL
  let rootURL: URL
  let resourceToken: String

  init(document: MarkdownDocument, resourceToken: String) {
    documentURL = document.url.standardizedFileURL
    rootURL =
      (document.resourceRootURL ?? document.url.deletingLastPathComponent())
      .standardizedFileURL
    self.resourceToken = resourceToken
  }
}

struct DocumentResourceResolver: Sendable {
  func resourceURL(
    for requestURL: URL,
    context: DocumentResourceContext
  ) -> URL? {
    guard
      requestURL.scheme == DocumentResourceSchemeHandler.scheme,
      requestURL.host == "image",
      requestURL.path(percentEncoded: false) == "/\(context.resourceToken)",
      let components = URLComponents(
        url: requestURL,
        resolvingAgainstBaseURL: false
      ),
      let rawSource = components.queryItems?.first(where: { $0.name == "path" })?.value
    else { return nil }

    let pathWithoutSuffix =
      rawSource.split(
        maxSplits: 1,
        omittingEmptySubsequences: false
      ) { character in
        character == "?" || character == "#"
      }.first.map(String.init) ?? ""
    let sourcePath = pathWithoutSuffix.removingPercentEncoding ?? pathWithoutSuffix
    guard
      !sourcePath.isEmpty,
      !sourcePath.contains("\0"),
      !sourcePath.hasPrefix("//"),
      URLComponents(string: sourcePath)?.scheme == nil
    else { return nil }

    let isRootRelative = sourcePath.hasPrefix("/")
    let relativePath = isRootRelative ? String(sourcePath.dropFirst()) : sourcePath
    guard !relativePath.isEmpty else { return nil }

    let baseURL =
      isRootRelative
      ? context.rootURL
      : context.documentURL.deletingLastPathComponent()
    let lexicalRootURL = context.rootURL.standardizedFileURL
    let lexicalCandidateURL = baseURL.appending(path: relativePath).standardizedFileURL
    guard Self.contains(lexicalCandidateURL, in: lexicalRootURL) else { return nil }

    let rootURL = lexicalRootURL.resolvingSymlinksInPath().standardizedFileURL
    let resolvedParentURL = lexicalCandidateURL.deletingLastPathComponent()
      .resolvingSymlinksInPath()
      .standardizedFileURL
    let candidateURL =
      resolvedParentURL
      .appendingPathComponent(lexicalCandidateURL.lastPathComponent)
      .resolvingSymlinksInPath()
      .standardizedFileURL
    guard Self.contains(candidateURL, in: rootURL) else { return nil }
    return candidateURL
  }

  static func contains(_ candidateURL: URL, in rootURL: URL) -> Bool {
    let rootPath = rootURL.path(percentEncoded: false)
    let candidatePath = candidateURL.path(percentEncoded: false)
    guard candidatePath != rootPath else { return false }
    if rootPath == "/" { return candidatePath.hasPrefix("/") }
    let boundary = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
    return candidatePath.hasPrefix(boundary)
  }
}

struct LoadedDocumentResource: Sendable {
  let data: Data
  let mimeType: String
}

struct DocumentResourceLoader: Sendable {
  static let maximumFileSize = 25 * 1_024 * 1_024
  static let supportedExtensions: Set<String> = [
    "avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "tif", "tiff",
    "webp",
  ]

  func load(at url: URL, rootURL: URL) throws -> LoadedDocumentResource {
    let fileExtension = url.pathExtension.lowercased()
    guard Self.supportedExtensions.contains(fileExtension) else {
      throw DocumentResourceError.unsupportedImageType(fileExtension)
    }

    let descriptor = open(url.path(percentEncoded: false), O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
    guard descriptor >= 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)

    var fileStatus = stat()
    guard fstat(descriptor, &fileStatus) == 0 else {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
    guard (fileStatus.st_mode & S_IFMT) == S_IFREG else {
      throw DocumentResourceError.notRegularFile
    }
    guard fileStatus.st_size <= Self.maximumFileSize else {
      throw DocumentResourceError.fileTooLarge(Int(fileStatus.st_size))
    }

    var descriptorInfo = vnode_fdinfowithpath()
    let descriptorInfoSize = Int32(MemoryLayout.size(ofValue: descriptorInfo))
    guard
      proc_pidfdinfo(
        getpid(),
        descriptor,
        PROC_PIDFDVNODEPATHINFO,
        &descriptorInfo,
        descriptorInfoSize
      ) == descriptorInfoSize
    else {
      throw DocumentResourceError.couldNotVerifyOpenedFile
    }
    let openedPath = withUnsafePointer(to: &descriptorInfo.pvip.vip_path) { pointer in
      pointer.withMemoryRebound(to: UInt8.self, capacity: Int(MAXPATHLEN)) {
        String(decodingCString: $0, as: UTF8.self)
      }
    }
    let openedURL = URL(fileURLWithPath: openedPath)
      .resolvingSymlinksInPath()
      .standardizedFileURL
    let resolvedRootURL = rootURL.resolvingSymlinksInPath().standardizedFileURL
    guard DocumentResourceResolver.contains(openedURL, in: resolvedRootURL) else {
      throw DocumentResourceError.openedFileOutsideWorkspace
    }

    let data = try handle.read(upToCount: Self.maximumFileSize + 1) ?? Data()
    guard data.count <= Self.maximumFileSize else {
      throw DocumentResourceError.fileTooLarge(data.count)
    }
    let type = UTType(filenameExtension: fileExtension)
    guard let type, type.conforms(to: .image), let mimeType = type.preferredMIMEType else {
      throw DocumentResourceError.unsupportedImageType(fileExtension)
    }
    return LoadedDocumentResource(data: data, mimeType: mimeType)
  }
}

@MainActor
final class DocumentResourceSchemeHandler: NSObject, WKURLSchemeHandler {
  nonisolated static let scheme = "flux-reader-resource"

  private let resolver = DocumentResourceResolver()
  private let loader = DocumentResourceLoader()
  private var context: DocumentResourceContext?
  private var pendingTasks: [ObjectIdentifier: Task<Void, Never>] = [:]

  func update(document: MarkdownDocument, resourceToken: String) {
    context = DocumentResourceContext(
      document: document,
      resourceToken: resourceToken
    )
  }

  func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
    guard
      let requestURL = urlSchemeTask.request.url,
      let context,
      let resourceURL = resolver.resourceURL(for: requestURL, context: context)
    else {
      urlSchemeTask.didFailWithError(
        DocumentResourceError.invalidRequest(urlSchemeTask.request.url)
      )
      return
    }

    pendingTasks[identifier]?.cancel()
    let loader = self.loader
    let resourceRootURL = context.rootURL
    pendingTasks[identifier] = Task { [weak self] in
      defer { self?.pendingTasks[identifier] = nil }
      do {
        let resource = try await Task.detached(priority: .userInitiated) {
          try loader.load(at: resourceURL, rootURL: resourceRootURL)
        }.value
        try Task.checkCancellation()

        let response = URLResponse(
          url: requestURL,
          mimeType: resource.mimeType,
          expectedContentLength: resource.data.count,
          textEncodingName: nil
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(resource.data)
        urlSchemeTask.didFinish()
      } catch is CancellationError {
        return
      } catch {
        urlSchemeTask.didFailWithError(error)
      }
    }
  }

  func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    let identifier = ObjectIdentifier(urlSchemeTask as AnyObject)
    pendingTasks.removeValue(forKey: identifier)?.cancel()
  }
}

private enum DocumentResourceError: LocalizedError {
  case invalidRequest(URL?)
  case notRegularFile
  case unsupportedImageType(String)
  case fileTooLarge(Int)
  case couldNotVerifyOpenedFile
  case openedFileOutsideWorkspace

  var errorDescription: String? {
    switch self {
    case .invalidRequest(let url):
      "本地图片请求不合法：\(url?.absoluteString ?? "<nil>")"
    case .notRegularFile:
      "本地图片不是普通文件。"
    case .unsupportedImageType(let fileExtension):
      "不支持本地图片类型 .\(fileExtension)。"
    case .fileTooLarge(let size):
      "本地图片大小 \(size) 字节，超过 25 MB 限制。"
    case .couldNotVerifyOpenedFile:
      "无法核验已打开本地图片的真实路径。"
    case .openedFileOutsideWorkspace:
      "已打开的本地图片超出工作区授权范围。"
    }
  }
}
