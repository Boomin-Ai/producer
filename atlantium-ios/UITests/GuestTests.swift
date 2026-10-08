import XCTest
final class GuestTests: XCTestCase {
    func testEntranceDesign() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--preview-welcome"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue without an account"].waitForExistence(timeout: 15))
        save(app, "Atlantium welcome")
        app.buttons["Sign in"].tap()
        XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Verify with email"].isEnabled)
        XCTAssertTrue(app.buttons["Continue with Google"].exists)
        XCTAssertFalse(app.buttons["Continue without an account"].exists)
        XCTAssertTrue(app.staticTexts["Your path to\nthe frontier."].exists)
        save(app, "Atlantium sign in")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.buttons["Continue without an account"].waitForExistence(timeout: 10))
    }
    func testAccountDesignPreview() throws {
        let app = XCUIApplication(); app.launchArguments = ["--preview-account"]; app.launch()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Edit profile"].exists)
        XCTAssertTrue(app.staticTexts["Notifications"].exists)
        save(app, "Account design preview")
    }
    func testHQAccountSheet() throws {
        let app = XCUIApplication(); app.launch(); handleWelcome(app); handlePrompt(app)
        app.tabBars.buttons["HQ"].tap()
        let account = app.buttons["Account"]
        if !account.waitForExistence(timeout: 4) {
            let welcome = app.buttons["Welcome to Atlantium"]
            XCTAssertTrue(welcome.exists)
            welcome.tap()
            XCTAssertTrue(app.buttons["Continue without an account"].waitForExistence(timeout: 10))
            return
        }
        XCTAssertEqual(app.buttons.matching(identifier: "Account").count, 1)
        account.tap()
        XCTAssertTrue(app.navigationBars["Account"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Edit profile"].exists)
        save(app, "Redesigned account")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["HQ"].exists)
    }
    func testHQAndInboxNavigation() throws {
        let app = XCUIApplication()
        app.launch()
        handleWelcome(app)
        handlePrompt(app)
        XCTAssertTrue(app.tabBars.buttons["HQ"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.tabBars.buttons["Events"].exists)
        app.tabBars.buttons["HQ"].tap()
        XCTAssertTrue(app.navigationBars["HQ"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["THE LOBBY"].waitForExistence(timeout: 10))
        app.swipeUp()
        XCTAssertTrue(app.staticTexts["Upcoming events"].waitForExistence(timeout: 10))
        save(app, "HQ lobby and events")
        app.tabBars.buttons["Inbox"].tap()
        XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
        if app.staticTexts["Rene"].waitForExistence(timeout: 5) {
            app.staticTexts["Rene"].firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Rene"].waitForExistence(timeout: 10))
            XCTAssertFalse(app.tabBars.firstMatch.exists)
            save(app, "Rene in Inbox")
        } else {
            XCTAssertTrue(app.buttons["Sign in"].exists)
        }
    }
    func testPublicNavigationAndGuestRene() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--verify-push"]
        app.launch()
        handleWelcome(app)
        handlePrompt(app)
        XCTAssertTrue(app.navigationBars["HQ"].waitForExistence(timeout: 20))
        app.tabBars.buttons["Frontier"].tap()
        app.buttons["Open menu"].tap()
        app.buttons["Jobs"].tap()
        XCTAssertTrue(app.staticTexts["Loading jobs…"].waitForNonExistence(timeout: 25))
        XCTAssertTrue(app.cells.firstMatch.waitForExistence(timeout: 15))
        save(app, "Jobs")
        app.buttons["Done"].tap()
        app.buttons["Open menu"].tap()
        app.buttons["Directory"].tap()
        XCTAssertTrue(app.staticTexts["Loading directory…"].waitForNonExistence(timeout: 25))
        XCTAssertTrue(app.cells.firstMatch.waitForExistence(timeout: 15))
        save(app, "Directory")
        app.buttons["Done"].tap()
        app.tabBars.buttons["Network"].tap()
        XCTAssertTrue(app.staticTexts["Meet your people"].waitForExistence(timeout: 10))
        app.tabBars.buttons["Rene"].tap()
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertTrue(app.buttons["Find tech work"].waitForExistence(timeout: 10))
        app.buttons["Find tech work"].tap()
        XCTAssertTrue(app.buttons["Sign in to begin"].waitForExistence(timeout: 10))
        save(app, "Rene")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.tabBars.firstMatch.exists)
        app.tabBars.buttons["Events"].tap()
        XCTAssertTrue(app.navigationBars["Events"].waitForExistence(timeout: 10))
        save(app, "Events")
    }
    func testNativeReneNavigation() throws {
        let app = XCUIApplication()
        app.launch()
        handleWelcome(app)
        handlePrompt(app)
        XCTAssertTrue(app.tabBars.buttons["Rene"].waitForExistence(timeout: 20))
        app.tabBars.buttons["Rene"].tap()
        XCTAssertTrue(app.buttons["Find tech work"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        app.buttons["Find tech work"].tap()
        XCTAssertTrue(app.buttons["Sign in to begin"].waitForExistence(timeout: 10))
        save(app, "Native Rene glass")
        app.buttons["Back"].tap()
        XCTAssertTrue(app.tabBars.buttons["Frontier"].waitForExistence(timeout: 10))
    }
    func testFirstLaunchChoices() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--show-welcome"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue without an account"].waitForExistence(timeout: 20))
        app.buttons["Sign in"].tap()
        XCTAssertTrue(app.textFields["Email address"].waitForExistence(timeout: 10))
        app.buttons["Back"].tap()
        app.buttons["Continue without an account"].tap()
        handlePrompt(app)
        XCTAssertTrue(app.tabBars.buttons["Frontier"].waitForExistence(timeout: 10))
        app.terminate(); app.launchArguments = []; app.launch(); handlePrompt(app)
        XCTAssertTrue(app.tabBars.buttons["Frontier"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Continue without an account"].exists)
        app.buttons["Welcome to Atlantium"].tap()
        XCTAssertTrue(app.buttons["Continue without an account"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.textFields["Email address"].exists)
        app.buttons["Continue without an account"].tap()
        XCTAssertTrue(app.tabBars.buttons["Frontier"].waitForExistence(timeout: 10))
    }
    func testTapOutsideDismissesSignInKeyboard() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--preview-welcome"]
        app.launch()
        XCTAssertTrue(app.buttons["Sign in"].waitForExistence(timeout: 20))
        app.buttons["Sign in"].tap()
        let email = app.textFields["Email address"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap()
        email.typeText("keyboard-check")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["ATLANTIUM"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        email.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        app.staticTexts["ATLANTIUM"].tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5))
        save(app, "Compact sign-in keyboard dismissal")
    }
    func handleWelcome(_ app: XCUIApplication) {
        if app.buttons["Continue without an account"].waitForExistence(timeout: 3) { app.buttons["Continue without an account"].tap() }
    }
    func handlePrompt(_ app: XCUIApplication) {
        if app.alerts.firstMatch.waitForExistence(timeout: 8), app.alerts.buttons["Got it"].exists { app.alerts.buttons["Got it"].tap(); if app.alerts.buttons["Don’t Allow"].waitForExistence(timeout: 5) { app.alerts.buttons["Don’t Allow"].tap() } }
    }
    func save(_ app: XCUIApplication, _ name: String) { let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment) }
}
