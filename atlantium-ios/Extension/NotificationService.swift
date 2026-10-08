import UserNotifications
import OneSignalExtension

final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var receivedRequest: UNNotificationRequest?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        receivedRequest = request
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        bestAttemptContent = content
        OneSignalExtension.didReceiveNotificationExtensionRequest(request, with: content, withContentHandler: contentHandler)
    }

    override func serviceExtensionTimeWillExpire() {
        guard let request = receivedRequest, let content = bestAttemptContent, let handler = contentHandler else { return }
        OneSignalExtension.serviceExtensionTimeWillExpireRequest(request, with: content)
        handler(content)
    }
}
