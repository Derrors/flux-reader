import SwiftUI
import WebKit
import XCTest

@testable import FluxReader

final class AppAppearanceTests: XCTestCase {
  func testAppearanceOptionsAndPreferredColorSchemes() {
    XCTAssertEqual(AppAppearance.defaultValue, .light)
    XCTAssertEqual(AppAppearance.allCases, [.system, .light, .dark])
    XCTAssertNil(AppAppearance.system.preferredColorScheme)
    XCTAssertEqual(AppAppearance.light.preferredColorScheme, .light)
    XCTAssertEqual(AppAppearance.dark.preferredColorScheme, .dark)
  }

  func testAppearancePersistsThroughAppStorage() throws {
    let suiteName = "AppAppearanceTests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }

    let storage = AppStorage(
      wrappedValue: AppAppearance.defaultValue,
      AppAppearance.storageKey,
      store: defaults
    )

    XCTAssertEqual(storage.wrappedValue, .light)
    storage.wrappedValue = .dark
    XCTAssertEqual(defaults.string(forKey: AppAppearance.storageKey), AppAppearance.dark.rawValue)

    let restoredStorage = AppStorage(
      wrappedValue: AppAppearance.defaultValue,
      AppAppearance.storageKey,
      store: defaults
    )
    XCTAssertEqual(restoredStorage.wrappedValue, .dark)
    restoredStorage.wrappedValue = .system
    XCTAssertEqual(defaults.string(forKey: AppAppearance.storageKey), AppAppearance.system.rawValue)
  }
}

final class WebRendererTests: XCTestCase {
  @MainActor
  func testBundledRendererEntryAndConfiguration() throws {
    let rendererURL = try XCTUnwrap(WebMarkdownView.rendererURL)
    XCTAssertTrue(FileManager.default.fileExists(atPath: rendererURL.path))

    let html = try String(contentsOf: rendererURL, encoding: .utf8)
    XCTAssertTrue(html.contains("Content-Security-Policy"))
    XCTAssertTrue(html.contains("img-src 'self' https: flux-reader-resource:"))
    XCTAssertTrue(html.contains("type=\"module\""))

    let schemeHandler = RendererSchemeHandler(
      rootURL: rendererURL.deletingLastPathComponent()
    )
    XCTAssertEqual(
      schemeHandler.resourceURL(for: WebMarkdownView.rendererEntryURL),
      rendererURL
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "https://app.example/macos.html")!
      )
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "flux-reader://other/macos.html")!
      )
    )
    XCTAssertNil(
      schemeHandler.resourceURL(
        for: URL(string: "flux-reader://app/%2E%2E/Info.plist")!
      )
    )

    let configuration = try XCTUnwrap(
      WebMarkdownView.makeConfiguration(
        contentController: WKUserContentController()
      )
    )
    XCTAssertNotNil(
      configuration.urlSchemeHandler(
        forURLScheme: RendererSchemeHandler.scheme
      )
    )
    XCTAssertNotNil(
      configuration.urlSchemeHandler(
        forURLScheme: DocumentResourceSchemeHandler.scheme
      )
    )
  }

  func testDocumentResourceResolverStaysInsideWorkspaceAndRejectsSymlinkEscape() throws {
    let rootURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let docsURL = rootURL.appendingPathComponent("docs", isDirectory: true)
    let imagesURL = rootURL.appendingPathComponent("images", isDirectory: true)
    let outsideURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    defer {
      try? FileManager.default.removeItem(at: rootURL)
      try? FileManager.default.removeItem(at: outsideURL)
    }
    try FileManager.default.createDirectory(at: docsURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: imagesURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: outsideURL, withIntermediateDirectories: true)

    let documentURL = docsURL.appendingPathComponent("README.md")
    let imageURL = imagesURL.appendingPathComponent("封面 1.png")
    try Data("# Test".utf8).write(to: documentURL)
    try Data([0x89, 0x50, 0x4E, 0x47]).write(to: imageURL)
    try Data([0x89, 0x50, 0x4E, 0x47]).write(
      to: outsideURL.appendingPathComponent("secret.png")
    )
    try FileManager.default.createSymbolicLink(
      at: rootURL.appendingPathComponent("escaped", isDirectory: true),
      withDestinationURL: outsideURL
    )

    let document = MarkdownDocument(
      url: documentURL,
      content: "",
      byteCount: 0,
      modificationDate: nil,
      resourceRootURL: rootURL
    )
    let context = DocumentResourceContext(
      document: document,
      resourceToken: "test-token"
    )
    let resolver = DocumentResourceResolver()
    let loader = DocumentResourceLoader()

    XCTAssertEqual(
      resolver.resourceURL(
        for: try resourceRequest("../images/%E5%B0%81%E9%9D%A2%201.png"),
        context: context
      ),
      imageURL.standardizedFileURL
    )
    XCTAssertEqual(
      resolver.resourceURL(
        for: try resourceRequest("/images/%E5%B0%81%E9%9D%A2%201.png"),
        context: context
      ),
      imageURL.standardizedFileURL
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest("../../outside.png"),
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest("/escaped/secret.png"),
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: URL(string: "https://example.com/image.png")!,
        context: context
      )
    )
    XCTAssertNil(
      resolver.resourceURL(
        for: try resourceRequest(
          "/images/%E5%B0%81%E9%9D%A2%201.png",
          token: "stale-token"
        ),
        context: context
      )
    )

    let loaded = try loader.load(at: imageURL, rootURL: rootURL)
    XCTAssertEqual(loaded.data, Data([0x89, 0x50, 0x4E, 0x47]))
    XCTAssertEqual(loaded.mimeType, "image/png")
    XCTAssertThrowsError(
      try loader.load(
        at: rootURL.appendingPathComponent("escaped/secret.png"),
        rootURL: rootURL
      )
    )
  }

  private func resourceRequest(
    _ source: String,
    token: String = "test-token"
  ) throws -> URL {
    var components = URLComponents()
    components.scheme = DocumentResourceSchemeHandler.scheme
    components.host = "image"
    components.path = "/\(token)"
    components.queryItems = [URLQueryItem(name: "path", value: source)]
    return try XCTUnwrap(components.url)
  }
}
