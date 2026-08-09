import XCTest

@MainActor
final class FluxReaderUITests: XCTestCase {
  override func setUpWithError() throws {
    continueAfterFailure = false
  }

  private func makeApplication() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
    return app
  }

  func testLaunchesReaderControls() {
    let app = makeApplication()
    app.launch()

    XCTAssertTrue(app.staticTexts["flux.empty-title"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["flux.open-file"].exists)
    XCTAssertTrue(app.buttons["flux.open-folder"].exists)
    XCTAssertTrue(app.searchFields["搜索文件名和正文"].exists)
  }

  func testRendersInjectedMarkdownDocument() {
    let app = makeApplication()
    app.launchEnvironment["FLUX_READER_UI_TESTING"] = "1"
    app.launchEnvironment["FLUX_READER_UI_TEST_MARKDOWN"] =
      "# UI Smoke\n\nRendered from XCUITest."
    app.launch()

    let currentDocument = app.staticTexts["flux.current-document"]
    XCTAssertTrue(currentDocument.waitForExistence(timeout: 8))
    XCTAssertEqual(currentDocument.value as? String, "FluxReaderUITest.md")
    XCTAssertTrue(app.staticTexts["UI Smoke"].waitForExistence(timeout: 12))
  }

  func testEditsSavesAndPreviewsInjectedMarkdownDocument() {
    let app = makeApplication()
    app.launchEnvironment["FLUX_READER_UI_TESTING"] = "1"
    app.launchEnvironment["FLUX_READER_UI_TEST_MARKDOWN"] =
      "# Original title\n\nOriginal body."
    app.launch()

    let editButton = app.buttons["flux.edit"]
    XCTAssertTrue(editButton.waitForExistence(timeout: 8))
    editButton.click()

    let editor = app.textViews["flux.editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: 8))
    editor.click()
    editor.typeKey("a", modifierFlags: .command)
    editor.typeText("# Saved")

    let dirtyIndicator = app.staticTexts["flux.dirty-indicator"]
    XCTAssertTrue(dirtyIndicator.waitForExistence(timeout: 5))

    let saveButton = app.buttons["flux.save"]
    XCTAssertTrue(saveButton.isEnabled)
    saveButton.click()
    XCTAssertTrue(dirtyIndicator.waitForNonExistence(timeout: 8))

    editButton.click()
    XCTAssertTrue(app.staticTexts["Saved"].waitForExistence(timeout: 12))
  }
}
