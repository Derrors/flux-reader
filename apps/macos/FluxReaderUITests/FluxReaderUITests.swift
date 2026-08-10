import XCTest

@MainActor
final class FluxReaderUITests: XCTestCase {
  private var testApplications: [XCUIApplication] = []

  override func setUpWithError() throws {
    try super.setUpWithError()
    continueAfterFailure = false
    testApplications.removeAll()
  }

  override func tearDownWithError() throws {
    for app in testApplications.reversed() where app.state != .notRunning {
      app.terminate()
    }
    testApplications.removeAll()
    try super.tearDownWithError()
  }

  private func makeApplication() -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
    app.launchEnvironment["FLUX_READER_UI_TESTING"] = "1"
    app.launchEnvironment["FLUX_READER_UI_TEST_DOCUMENT_ID"] =
      "isolated-\(UUID().uuidString)"
    app.launchEnvironment["FLUX_READER_UI_TEST_CLEAR_RECOVERY"] = "1"
    testApplications.append(app)
    return app
  }

  private func waitUntilHittable(
    _ element: XCUIElement,
    timeout: TimeInterval
  ) -> Bool {
    guard element.waitForExistence(timeout: timeout) else {
      return false
    }

    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "exists == true AND hittable == true"),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func waitUntilValue(
    of element: XCUIElement,
    contains expectedValue: String,
    timeout: TimeInterval
  ) -> Bool {
    guard element.waitForExistence(timeout: timeout) else {
      return false
    }

    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "value CONTAINS %@", expectedValue),
      object: element
    )
    return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
  }

  private func cancelInteraction(
    using cancelButton: XCUIElement,
    in app: XCUIApplication,
    timeout: TimeInterval = 5
  ) {
    XCTAssertTrue(cancelButton.waitForExistence(timeout: timeout))
    if waitUntilHittable(cancelButton, timeout: timeout) {
      cancelButton.click()
    } else {
      app.typeKey(.escape, modifierFlags: [])
    }
    XCTAssertTrue(cancelButton.waitForNonExistence(timeout: timeout))
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: timeout))
  }

  private func enterEditMode(
    in app: XCUIApplication,
    timeout: TimeInterval = 8
  ) -> XCUIElement {
    let currentDocument = app.staticTexts["flux.current-document"]
    XCTAssertTrue(currentDocument.waitForExistence(timeout: timeout))

    app.activate()
    app.typeKey("e", modifierFlags: .command)

    let editor = app.textViews["flux.editor"]
    XCTAssertTrue(editor.waitForExistence(timeout: timeout))
    return editor
  }

  private func configureTestDocument(
    _ app: XCUIApplication,
    id: String,
    content: String? = nil,
    resetsDocument: Bool = false,
    clearsRecovery: Bool = false
  ) {
    app.launchEnvironment["FLUX_READER_UI_TESTING"] = "1"
    app.launchEnvironment["FLUX_READER_UI_TEST_DOCUMENT_ID"] = id
    app.launchEnvironment["FLUX_READER_UI_TEST_DOCUMENT_ENABLED"] = "1"
    if let content {
      app.launchEnvironment["FLUX_READER_UI_TEST_MARKDOWN"] = content
    }
    app.launchEnvironment["FLUX_READER_UI_TEST_RESET_DOCUMENT"] =
      resetsDocument ? "1" : "0"
    app.launchEnvironment["FLUX_READER_UI_TEST_CLEAR_RECOVERY"] =
      clearsRecovery ? "1" : "0"
  }

  func testLaunchesReaderControls() {
    let app = makeApplication()
    XCTAssertEqual(app.launchEnvironment["FLUX_READER_UI_TESTING"], "1")
    XCTAssertTrue(
      app.launchEnvironment["FLUX_READER_UI_TEST_DOCUMENT_ID"]?
        .hasPrefix("isolated-") == true
    )
    app.launch()

    XCTAssertTrue(app.staticTexts["flux.empty-title"].waitForExistence(timeout: 8))
    XCTAssertTrue(app.buttons["flux.open-file"].exists)
    XCTAssertTrue(app.buttons["flux.open-folder"].exists)
    XCTAssertTrue(app.searchFields["搜索文件名和正文"].exists)
  }

  func testRendersInjectedMarkdownDocument() {
    let app = makeApplication()
    configureTestDocument(
      app,
      id: "render-smoke",
      content: "# UI Smoke\n\nRendered from XCUITest.",
      resetsDocument: true,
      clearsRecovery: true
    )
    app.launch()

    let currentDocument = app.staticTexts["flux.current-document"]
    XCTAssertTrue(currentDocument.waitForExistence(timeout: 8))
    XCTAssertTrue(
      waitUntilValue(
        of: currentDocument,
        contains: "FluxReaderUITest.md",
        timeout: 5
      )
    )
    XCTAssertTrue(app.staticTexts["UI Smoke"].waitForExistence(timeout: 12))
  }

  func testEditsSavesPreviewsAndRelaunchesInjectedMarkdownDocument() {
    let app = makeApplication()
    configureTestDocument(
      app,
      id: "edit-save-relaunch",
      content: "# Original title\n\nOriginal body.",
      resetsDocument: true,
      clearsRecovery: true
    )
    app.launch()

    let editor = enterEditMode(in: app)
    editor.click()
    editor.typeKey("a", modifierFlags: .command)
    editor.typeText("# Saved")

    let dirtyIndicator = app.staticTexts["flux.dirty-indicator"]
    XCTAssertTrue(dirtyIndicator.waitForExistence(timeout: 5))

    XCTAssertTrue(app.buttons["flux.save"].isEnabled)
    app.typeKey("s", modifierFlags: .command)
    XCTAssertTrue(dirtyIndicator.waitForNonExistence(timeout: 8))

    // Keep this UI test focused on the stable user journey. Recovery-version
    // path resolution, read-only enforcement, retention, and deletion are
    // covered by deterministic ReaderViewModel and LocalFileService tests.
    let recoverySection = app.staticTexts["保存恢复版本"]
    XCTAssertTrue(recoverySection.waitForExistence(timeout: 8))
    app.typeKey("e", modifierFlags: .command)
    XCTAssertTrue(app.staticTexts["Saved"].waitForExistence(timeout: 12))

    app.terminate()
    let relaunchedApp = makeApplication()
    configureTestDocument(relaunchedApp, id: "edit-save-relaunch")
    relaunchedApp.launch()
    XCTAssertTrue(relaunchedApp.staticTexts["Saved"].waitForExistence(timeout: 12))
  }

  func testRestoresDirtyDraftAcrossForcedTerminationWithoutOverwritingDisk() {
    let app = makeApplication()
    configureTestDocument(
      app,
      id: "crash-recovery",
      content: "# Disk version",
      resetsDocument: true,
      clearsRecovery: true
    )
    app.launchEnvironment["FLUX_READER_UI_TEST_FORCE_TERMINATION"] = "1"
    app.launch()

    let editor = enterEditMode(in: app)
    editor.click()
    editor.typeKey("a", modifierFlags: .command)
    editor.typeText("# Recovered after crash")
    XCTAssertTrue(app.staticTexts["flux.dirty-indicator"].waitForExistence(timeout: 5))
    Thread.sleep(forTimeInterval: 1.0)
    app.terminate()

    let recoveredApp = makeApplication()
    configureTestDocument(recoveredApp, id: "crash-recovery")
    recoveredApp.launch()

    let continueEditingButton = recoveredApp.sheets.buttons["继续编辑"]
    XCTAssertTrue(waitUntilHittable(continueEditingButton, timeout: 10))
    continueEditingButton.click()
    let recoveredEditor = recoveredApp.textViews["flux.editor"]
    XCTAssertTrue(
      waitUntilValue(
        of: recoveredEditor,
        contains: "Recovered after crash",
        timeout: 8
      )
    )

    recoveredApp.typeKey("q", modifierFlags: .command)
    let discardButton = recoveredApp.dialogs.buttons["不保存"]
    XCTAssertTrue(waitUntilHittable(discardButton, timeout: 5))
    discardButton.click()
    XCTAssertTrue(recoveredApp.wait(for: .notRunning, timeout: 8))
  }

  func testRecoveredDraftWarnsWhenDiskChangedAndPreservesBothVersions() {
    let app = makeApplication()
    configureTestDocument(
      app,
      id: "crash-conflict",
      content: "# Original disk version",
      resetsDocument: true,
      clearsRecovery: true
    )
    app.launchEnvironment["FLUX_READER_UI_TEST_FORCE_TERMINATION"] = "1"
    app.launch()
    let editor = enterEditMode(in: app)
    editor.click()
    editor.typeKey("a", modifierFlags: .command)
    editor.typeText("# Local recovered draft")
    XCTAssertTrue(
      app.staticTexts["flux.dirty-indicator"].waitForExistence(timeout: 5)
    )
    Thread.sleep(forTimeInterval: 1.0)
    app.terminate()

    let recoveredApp = makeApplication()
    configureTestDocument(recoveredApp, id: "crash-conflict")
    recoveredApp.launchEnvironment["FLUX_READER_UI_TEST_EXTERNAL_MARKDOWN"] =
      "# External disk version"
    recoveredApp.launch()

    let continueEditingButton = recoveredApp.sheets.buttons["继续编辑"]
    XCTAssertTrue(waitUntilHittable(continueEditingButton, timeout: 10))
    let conflictWarning = recoveredApp.sheets.staticTexts.matching(
      NSPredicate(format: "value CONTAINS %@", "磁盘版本")
    ).firstMatch
    XCTAssertTrue(
      conflictWarning.waitForExistence(timeout: 5)
    )
    continueEditingButton.click()
    let recoveredEditor = recoveredApp.textViews["flux.editor"]
    XCTAssertTrue(
      waitUntilValue(
        of: recoveredEditor,
        contains: "Local recovered draft",
        timeout: 8
      )
    )

    recoveredApp.typeKey("q", modifierFlags: .command)
    let discardButton = recoveredApp.dialogs.buttons["不保存"]
    XCTAssertTrue(waitUntilHittable(discardButton, timeout: 5))
    discardButton.click()
    XCTAssertTrue(recoveredApp.wait(for: .notRunning, timeout: 8))

    let diskApp = makeApplication()
    configureTestDocument(diskApp, id: "crash-conflict")
    diskApp.launch()
    XCTAssertTrue(
      diskApp.staticTexts["External disk version"].waitForExistence(timeout: 12)
    )
  }

  func testDirtyTabSurvivesSwitchAndQuitRequiresExplicitDecision() {
    let app = makeApplication()
    configureTestDocument(
      app,
      id: "switch-and-quit",
      content: "# First",
      resetsDocument: true,
      clearsRecovery: true
    )
    app.launchEnvironment["FLUX_READER_UI_TEST_SECOND_MARKDOWN"] = "# Second"
    app.launch()

    let secondDocument = app.buttons["Second.md"]
    XCTAssertTrue(secondDocument.waitForExistence(timeout: 10))
    let editor = enterEditMode(in: app)
    editor.click()
    editor.typeText("\nUnsaved")
    let dirtyIndicator = app.staticTexts["flux.dirty-indicator"]
    XCTAssertTrue(dirtyIndicator.waitForExistence(timeout: 5))

    XCTAssertTrue(waitUntilHittable(secondDocument, timeout: 5))
    secondDocument.click()
    let currentDocument = app.staticTexts["flux.current-document"]
    XCTAssertTrue(
      waitUntilValue(
        of: currentDocument,
        contains: "Second.md",
        timeout: 5
      )
    )

    let firstDocument = app.buttons["FluxReaderUITest.md"]
    XCTAssertTrue(waitUntilHittable(firstDocument, timeout: 5))
    firstDocument.click()
    XCTAssertTrue(
      waitUntilValue(
        of: currentDocument,
        contains: "FluxReaderUITest.md",
        timeout: 5
      )
    )
    XCTAssertTrue(dirtyIndicator.waitForExistence(timeout: 5))
    XCTAssertTrue(
      waitUntilValue(
        of: app.textViews["flux.editor"],
        contains: "Unsaved",
        timeout: 5
      )
    )

    app.typeKey("q", modifierFlags: .command)
    let quitCancelButton = app.dialogs.buttons["取消"]
    cancelInteraction(using: quitCancelButton, in: app)
    XCTAssertTrue(dirtyIndicator.waitForExistence(timeout: 5))

    app.typeKey("q", modifierFlags: .command)
    let discardButton = app.dialogs.buttons["不保存"]
    XCTAssertTrue(waitUntilHittable(discardButton, timeout: 5))
    discardButton.click()
    XCTAssertTrue(app.wait(for: .notRunning, timeout: 8))
  }
}
