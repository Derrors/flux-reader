import XCTest

@MainActor
final class FluxReaderUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  func testLaunchesReaderControls() {
    let app = XCUIApplication()
    app.launch()

    XCTAssertTrue(app.staticTexts["flux.empty-title"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["flux.open-file"].exists)
    XCTAssertTrue(app.buttons["flux.open-folder"].exists)
    XCTAssertTrue(app.searchFields["搜索文件名和正文"].exists)
  }

  func testRendersInjectedMarkdownDocument() {
    let app = XCUIApplication()
    app.launchEnvironment["FLUX_READER_UI_TESTING"] = "1"
    app.launchEnvironment["FLUX_READER_UI_TEST_MARKDOWN"] =
      "# UI Smoke\n\nRendered from XCUITest."
    app.launch()

    let currentDocument = app.staticTexts["flux.current-document"]
    XCTAssertTrue(currentDocument.waitForExistence(timeout: 8))
    XCTAssertEqual(currentDocument.value as? String, "FluxReaderUITest.md")
    XCTAssertTrue(app.staticTexts["UI Smoke"].waitForExistence(timeout: 12))
  }
}
